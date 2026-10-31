import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connect as connectPipe, createServer } from 'node:net';
import {
  DockerMarkerSchema,
  IntegrationAgentIdSchema,
  type DockerMarker,
  type DockerMarkerPhase,
} from '@waleed/contracts';
import type { DockerCommand } from '../adapters/docker-profile.js';
import { assertNoLinks } from '../adapters/managed-files.js';
import { HubError } from '../errors.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import {
  cleanupOwnedContainers,
  inspectContainerLabels,
  removeInspectedContainer,
} from '../adapters/mcp/container-cleanup.js';

export type PipeKind = 'bridge' | 'recovery';
export type ProbeOutcome = 'live' | 'absent' | 'unknown';

// The clock of one owner: every timer of this module goes through it, so
// a test drives the deadlines and the probe timeouts with virtual time.
export interface OwnershipClock {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

// The real clock of the production code.
const realClock: OwnershipClock = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// The shutdown wait for the work that is still running: every wait shares
// one bound, so the process leaves at the bound even when a wait never
// ends. A wait that fails counts as finished: the shutdown never stalls on
// an error.
export function settleWithin(
  waits: readonly (Promise<unknown> | undefined)[],
  ms: number,
  clock: OwnershipClock,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = clock.setTimer(resolve, ms);
    void Promise.allSettled(waits).then(() => {
      clock.clearTimer(timer);
      resolve();
    });
  });
}

const lowerUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const containerId = /^[a-f0-9]{64}$/;
// The marker root of the installation, below the hub data folder.
const MARKER_ROOT = 'owned-agent-containers';
// The container id file of one session, below its bridge folder.
const CID_FOLDER = 'cid';
// The durable flag of an agent that used Docker: it is written once and
// never deleted, so a later bridge knows that this agent could hold a
// labelled container even when no marker is left.
const DOCKER_USED = 'docker-used';
// More than this many unresolved launching markers block the agent.
const MAX_LAUNCHING_MARKERS = 16;
// The recovery interval of an agent that still owes a cleanup.
const RECOVERY_INTERVAL_MS = 60_000;
// The bound of one liveness probe.
const PROBE_TIMEOUT_MS = 2_000;
// The bound of the commands of one recovery round.
const COMMAND_TIMEOUT_MS = 30_000;
// The number of containers one round of the label sweep inspects.
const SWEEP_BATCH_SIZE = 64;
// The number of markers one round of the marker pass reads.
const MARKER_BATCH_SIZE = 64;
// The number of owner probes one batch runs at the same time. The slow
// owners of a batch cost one probe bound, not one bound each.
const PROBE_CONCURRENCY = 16;
// The largest valid listing of the label sweep: the Docker CLI caps its
// output at 1 MiB, so 4 096 immutable ids fit in it.
const MAX_LISTED_IDS = 4_096;
// The number of bridge folders one round of the artifact purge examines.
// The batch is probed at the same time, so its slow owners cost one probe
// bound: the purge never holds the recovery mutex for long.
const PURGE_BATCH_SIZE = 16;
// The number of container id files one round of the artifact purge
// examines, across every bridge folder of the round: a folder with many
// files never holds the round past its share of the work.
const PURGE_FILE_BUDGET = 64;
// The poll interval of the container id file.
const WATCH_INTERVAL_MS = 250;
// The bound of the container id poll.
const WATCH_TIMEOUT_MS = 60_000;
// The prefix of the temporary file of one marker rewrite.
const TEMPORARY_MARKER = '.wmh-marker-';

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

// The only pipe naming in the code: the installation, the kind and the id.
// The installation id comes from install.json, never from a path, so two
// bridges that opened the data folder through differently cased paths share
// one recovery mutex.
export function pipeName(
  kind: PipeKind,
  installId: string,
  id: string,
): string {
  if (!lowerUuid.test(installId)) throw new Error();
  if (kind === 'bridge') {
    if (!lowerUuid.test(id)) throw new Error();
  } else if (!IntegrationAgentIdSchema.safeParse(id).success) throw new Error();
  return `\\\\.\\pipe\\wmh-${installId}-${kind}-${id}`;
}

// The bridge listener: it accepts and closes every connection at once and
// reads nothing. Its whole life is the life of the bridge.
export interface BridgeListener {
  close(): Promise<void>;
}

export function listenBridge(
  installId: string,
  bridgeId: string,
): Promise<BridgeListener> {
  const server = createServer((socket) => socket.destroy());
  return new Promise<BridgeListener>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName('bridge', installId, bridgeId));
  });
}

// The liveness probe of one bridge. It connects with a two second bound and
// has three outcomes: live (the owner answered and closed the connection),
// absent (the pipe does not exist) and unknown (everything else). Only an
// absent owner allows a destructive recovery. The bound is a timer of the
// clock of the owner, so a test drives it with virtual time.
export function probeBridge(
  installId: string,
  bridgeId: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  clock: OwnershipClock = realClock,
): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    let connected = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clock.clearTimer(timer);
      socket.destroy();
      resolve(outcome);
    };
    const socket = connectPipe(pipeName('bridge', installId, bridgeId));
    const timer = clock.setTimer(() => finish('unknown'), timeoutMs);
    socket.once('connect', () => {
      connected = true;
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' ? 'absent' : 'unknown');
    });
    // The owner answers a probe by closing the connection at once.
    socket.once('close', () => finish(connected ? 'live' : 'unknown'));
  });
}

// The verdicts of the owner probes of one round: one verdict per owner.
type ProbeCache = Map<string, ProbeOutcome>;

// The probes of one recovery round. The verdict of every owner is cached
// for the round, so one probe per owner decides the round. The owners of
// a batch are probed at the same time: the slow owners of a batch cost
// one probe bound, not one bound each.
interface RoundProbes {
  // The verdict of one owner: the first probe of the round decides.
  of(owner: string): Promise<ProbeOutcome>;
  // The verdicts of many owners: the probes run at the same time.
  batch(owners: readonly string[]): Promise<void>;
}

// The probes of the owners of one batch. They run at the same time and
// their verdicts fill the cache of the round, so the decisions that
// follow read them without a second probe. The bound of the parallelism
// keeps the batch inside the deadline of the round.
async function probeOwners(
  installId: string,
  owners: readonly string[],
  cache: ProbeCache,
  timeoutMs: number,
  clock: OwnershipClock,
): Promise<void> {
  const pending = [...new Set(owners)].filter((owner) => !cache.has(owner));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const owner = pending[next++];
      if (owner === undefined) return;
      cache.set(owner, await probeBridge(installId, owner, timeoutMs, clock));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, pending.length) }, worker),
  );
}

// The recovery mutex of one agent: exactly one process may hold it. The
// operating system releases it when that process dies.
export interface RecoveryLock {
  close(): Promise<void>;
}

export function acquireRecovery(
  installId: string,
  agentId: string,
): Promise<RecoveryLock | undefined> {
  const server = createServer((socket) => socket.destroy());
  return new Promise<RecoveryLock | undefined>((resolve) => {
    server.once('error', () => resolve(undefined));
    server.listen(pipeName('recovery', installId, agentId), () => {
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

export interface DockerOwnershipOptions extends OwnershipClock {
  // Every Docker CLI call of this module goes through this command.
  docker: DockerCommand;
  // The hub data folder: it holds install.json and the marker root.
  directory: string;
  agentId: string;
  bridgeId: string;
  installId: string;
  now(): number;
  probeTimeoutMs?: number;
  recoveryIntervalMs?: number;
  watchTimeoutMs?: number;
  // The pause point of one marker transition. The acknowledgement, the
  // disposal and the recovery of one launch write through one chain per
  // nonce, and a test interleaves them through this hook. The production
  // code never sets it.
  pauseTransition?: (nonce: string, phase: DockerMarkerPhase) => Promise<void>;
}

// One launched container session.
export interface DockerLaunch {
  nonce: string;
  connectorId: string;
  markerPath: string;
  cidfilePath: string;
  containerId?: string;
}

// The launch request of one container session.
export interface DockerLaunchRequest {
  connectorId: string;
  image: string;
  // The container run: the caller starts the CLI with the ownership labels
  // and the container id file this module names.
  start(labels: readonly string[], cidfilePath: string): Promise<void>;
}

export interface DockerOwnership {
  readonly bridgeId: string;
  readonly installId: string;
  // The number of the launch states this manager still holds. The
  // production code never reads it: the test asserts that a finished
  // launch keeps no state behind.
  readonly retainedLaunches: number;
  // The admission of one Docker peer: the recovery round and the refusal
  // rules of the agent.
  admit(): Promise<void>;
  // The launch: the image pre-flight, the marker and the container.
  launch(
    request: DockerLaunchRequest,
    signal: AbortSignal,
  ): Promise<DockerLaunch>;
  // The acknowledgement: the marker moves to `running` once the container id
  // file holds the immutable id.
  watch(launch: DockerLaunch, signal: AbortSignal): Promise<string | undefined>;
  // The removal of one container session, normal or after a death.
  dispose(launch: DockerLaunch, signal: AbortSignal): Promise<void>;
  // One recovery round of this agent.
  recover(): Promise<void>;
  // The end of the recovery rounds that are running: it resolves once no
  // round runs, and it never rejects. The shutdown bounds the wait.
  settled(): Promise<void>;
  // The end of the scheduling: no round starts and no timer is armed after
  // it. A round that is running finishes within its own deadline.
  close(): Promise<void>;
}

// One marker of the agent: the file, the bridge that wrote it and the
// session it names. A marker that does not parse, or whose body does not
// match its path, is uncertain cleanup: it is kept and it blocks the agent.
interface MarkerEntry {
  path: string;
  bridgeId: string;
  nonce: string;
  // The body of the marker, when the file parses.
  marker?: DockerMarker;
  // The body matches its path: the marker may be used as evidence.
  bound: boolean;
}

// The inventory of the agent: its markers and the doubt about it. The
// inventory fails closed: only a missing folder is empty. An unreadable
// folder, an unsafe entry or a marker that does not parse makes it
// uncertain, and an uncertain agent is blocked and never cleaned.
interface MarkerInventory {
  entries: MarkerEntry[];
  uncertain: boolean;
}

// The state of one launch: its acknowledgement is joined by the disposal
// and its marker transitions run on the chain of its nonce.
interface LaunchState {
  nonce: string;
  connectorId: string;
  markerPath: string;
  cidfilePath: string;
  containerId?: string;
  // The acknowledgement of this launch.
  watcher?: Promise<string | undefined>;
  // No transition follows a disposal.
  stopped: boolean;
}

// The read of one folder: a missing folder is empty, every other failure is
// a doubt about the inventory.
type FolderRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'entries'; entries: Dirent[] };

async function readFolder(path: string): Promise<FolderRead> {
  try {
    return {
      kind: 'entries',
      entries: await readdir(path, { withFileTypes: true }),
    };
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
}

// The existence of a marker file: a missing marker is already gone, a
// marker that exists is owed to the recovery and a marker whose existence
// cannot be checked is a doubt that never authorises a removal.
type MarkerExistence = 'present' | 'absent' | 'unknown';

async function markerExists(path: string): Promise<MarkerExistence> {
  try {
    await lstat(path);
    return 'present';
  } catch (error) {
    // Only a missing marker is gone: every other failure is a doubt.
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unknown';
  }
}

// The marker of one session: the parsed body, when the file parses and
// carries no link.
async function readMarkerFile(path: string): Promise<DockerMarker | undefined> {
  try {
    await assertNoLinks(path);
    const bytes = await readFile(path);
    if (bytes.length > 64 * 1024) return undefined;
    const parsed = DockerMarkerSchema.safeParse(
      JSON.parse(bytes.toString('utf8')) as unknown,
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// The inventory of the markers of one agent. It fails closed: only a
// missing folder is empty, and every other doubt is reported.
async function readMarkerInventory(
  root: string,
  agentId: string,
): Promise<MarkerInventory> {
  const entries: MarkerEntry[] = [];
  let uncertain = false;
  const agentRoot = join(root, agentId);
  const bridges = await readFolder(agentRoot);
  if (bridges.kind === 'unreadable') return { entries, uncertain: true };
  if (bridges.kind === 'missing') return { entries, uncertain: false };
  for (const bridge of bridges.entries) {
    // The durable flag of the agent is not a bridge folder.
    if (bridge.name === DOCKER_USED) {
      if (!bridge.isFile()) uncertain = true;
      continue;
    }
    // Only a bridge folder belongs here: anything else is an unsafe entry.
    if (!bridge.isDirectory() || !lowerUuid.test(bridge.name)) {
      uncertain = true;
      continue;
    }
    const folder = join(agentRoot, bridge.name);
    const files = await readFolder(folder);
    if (files.kind === 'unreadable') {
      uncertain = true;
      continue;
    }
    if (files.kind === 'missing') continue;
    for (const file of files.entries) {
      // The container id folder of the sessions belongs to the bridge.
      if (file.name === CID_FOLDER && file.isDirectory()) continue;
      if (file.isFile() && file.name.endsWith('.json')) {
        const nonce = file.name.slice(0, -'.json'.length);
        const path = join(folder, file.name);
        const marker = await readMarkerFile(path);
        if (!nonce || !lowerUuid.test(nonce)) {
          uncertain = true;
          continue;
        }
        // The identity of a marker is bound to its path: a body that names
        // another agent, bridge or session is uncertain cleanup.
        const bound = Boolean(
          marker &&
          marker.agentId === agentId &&
          marker.bridgeId === bridge.name &&
          marker.nonce === nonce,
        );
        entries.push({
          path,
          bridgeId: bridge.name,
          nonce,
          ...(marker ? { marker } : {}),
          bound,
        });
        if (!bound) uncertain = true;
        continue;
      }
      // A temporary file of a marker rewrite is transient, not unsafe.
      if (file.isFile() && file.name.startsWith(TEMPORARY_MARKER)) continue;
      // A link, a socket or an unknown name is an unsafe entry.
      uncertain = true;
    }
  }
  return { entries, uncertain };
}

// The durable flag of the agent: it exists when the agent admitted a
// Docker peer at least once.
async function hasDockerUsedFlag(
  root: string,
  agentId: string,
): Promise<boolean> {
  const entries = await readFolder(join(root, agentId));
  if (entries.kind !== 'entries') return false;
  return entries.entries.some(
    (entry) => entry.name === DOCKER_USED && entry.isFile(),
  );
}

// A legacy marker is a pre-F03 file at the top of the marker root: it
// carries no agent or bridge identity, so it is never touched and it blocks
// Docker as it always did.
async function hasLegacyMarkers(root: string): Promise<boolean> {
  const entries = await readFolder(root);
  // An unreadable marker root is a doubt: the agent stays blocked.
  if (entries.kind === 'unreadable') return true;
  if (entries.kind === 'missing') return false;
  return entries.entries.some(
    (entry) =>
      !(
        entry.isDirectory() &&
        IntegrationAgentIdSchema.safeParse(entry.name).success
      ),
  );
}

// The scan of the agent at bridge start: it reads the marker folder of the
// agent without creating the Docker runtime.
export interface AgentMarkerScan {
  // The agent owns at least one marker file.
  present: boolean;
  // The inventory could not be read completely.
  uncertain: boolean;
  // A legacy marker exists at the top of the marker root.
  legacy: boolean;
  // The agent admitted a Docker peer before: a labelled container of this
  // agent may exist without a marker.
  dockerUsed: boolean;
}

export async function scanAgentMarkers(
  directory: string,
  agentId: string,
): Promise<AgentMarkerScan> {
  const root = join(resolve(directory), MARKER_ROOT);
  const inventory = await readMarkerInventory(root, agentId);
  return {
    present: inventory.entries.length > 0,
    uncertain: inventory.uncertain,
    legacy: await hasLegacyMarkers(root),
    dockerUsed: await hasDockerUsedFlag(root, agentId),
  };
}

// The startup recovery of one agent. The marker folder of the agent is
// checked without the Docker runtime: a bridge whose agent owns no marker,
// no enabled Docker connector and no durable Docker flag never creates the
// runtime.
export interface DockerStartupOptions {
  directory: string;
  agentId: string;
  // Whether the agent owns an enabled Docker connector.
  hasDockerConnector: boolean;
  // The runtime of the bridge: it is created only when a recovery is due.
  runtime(): Promise<DockerOwnership>;
}

// The condition of a due recovery: the agent could still hold a labelled
// container, so the sweep of the labels is owed to it. A marker, an
// uncertain inventory, an enabled Docker connector or the durable flag of an
// agent that used Docker.
export function agentOwesRecovery(
  scan: AgentMarkerScan,
  hasDockerConnector: boolean,
): boolean {
  return (
    scan.present || scan.uncertain || scan.dockerUsed || hasDockerConnector
  );
}

export async function startDockerRecovery(
  options: DockerStartupOptions,
): Promise<void> {
  const scan = await scanAgentMarkers(options.directory, options.agentId);
  // The sweep of the labels runs whenever this agent could hold a labelled
  // container: a marker, an enabled Docker connector or the durable flag of
  // an agent that used Docker.
  if (!agentOwesRecovery(scan, options.hasDockerConnector)) return;
  const ownership = await options.runtime();
  await ownership.recover();
}

// One Docker runtime per bridge: the whole initialization is memoized
// before its first await, so the startup recovery and the first admission
// share one ownership manager and one live set. A failed attempt does not
// disable the runtime: the promise is cleared and the next caller tries
// again.
export function createDockerRuntimeOnce<T>(
  create: () => Promise<T>,
): () => Promise<T> {
  let runtime: Promise<T> | undefined;
  return () => {
    runtime ??= create().catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
    return runtime;
  };
}

// The listing of the label sweep: every line is an immutable id and the
// listing holds at most MAX_LISTED_IDS of them. A listing that is longer
// or that carries a malformed line is uncertain: it is never read as "no
// container". The ids of a valid listing are unique and ordered, so the
// continuation of a round is stable.
function parseListing(listed: string): string[] | undefined {
  const lines = listed.trim() ? listed.trim().split(/\s+/) : [];
  if (lines.length > MAX_LISTED_IDS) return undefined;
  if (lines.some((id) => !containerId.test(id))) return undefined;
  return [...new Set(lines)].sort();
}

// The start of the next batch: the first item after the cursor of the
// previous round, or the first item of the list when the cursor is behind
// it. A cursor whose item is gone keeps its place in the order.
function resumeIndex(
  items: readonly string[],
  cursor: string | undefined,
): number {
  if (cursor === undefined) return 0;
  const index = items.findIndex((item) => item > cursor);
  return index === -1 ? 0 : index;
}

// The batch of one round: it starts after the cursor of the previous
// round, holds at most `size` items and wraps at the end of the list.
function batchOf(
  items: readonly string[],
  cursor: string | undefined,
  size: number,
): string[] {
  const start = resumeIndex(items, cursor);
  const batch: string[] = [];
  for (let offset = 0; offset < size && offset < items.length; offset++) {
    const item = items[(start + offset) % items.length];
    if (item === undefined) break;
    batch.push(item);
  }
  return batch;
}

// The hold of one cursor: the item a deadline interrupted and the number
// of consecutive rounds it was interrupted. The hold keeps the cursor at
// that item, so the next round starts at it again. A hold never removes
// an item: it only decides when the cursor may move past one.
interface CursorHold {
  // The item the cursor is held at.
  item: string | undefined;
  // The number of consecutive rounds the item was interrupted.
  rounds: number;
}

// A fresh hold: the cursor is not held at any item.
const newCursorHold = (): CursorHold => ({ item: undefined, rounds: 0 });

// The hold records the interruption of an item: the cursor stays at it.
const holdInterrupted = (hold: CursorHold, item: string): void => {
  if (hold.item === item) hold.rounds += 1;
  else {
    hold.item = item;
    hold.rounds = 1;
  }
};

// The hold asks for the deferral of an item: the deadline interrupted it
// in two consecutive rounds. The item is not examined in that round: the
// cursor moves past it and it is examined again after the cursor wraps.
const holdDeferred = (hold: CursorHold, item: string): boolean =>
  hold.item === item && hold.rounds >= 2;

// The hold is released: the item settled, it was deferred or it is gone.
const releaseHold = (hold: CursorHold): void => {
  hold.item = undefined;
  hold.rounds = 0;
};

export function createDockerOwnership(
  options: DockerOwnershipOptions,
): DockerOwnership {
  const docker = options.docker;
  const agentId = IntegrationAgentIdSchema.parse(options.agentId);
  const bridgeId = options.bridgeId;
  const installId = options.installId;
  const root = join(resolve(options.directory), MARKER_ROOT);
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const recoveryIntervalMs = options.recoveryIntervalMs ?? RECOVERY_INTERVAL_MS;
  const watchTimeoutMs = options.watchTimeoutMs ?? WATCH_TIMEOUT_MS;
  // The nonces of the live entries of this bridge.
  const live = new Set<string>();
  // The state of the launches of this bridge.
  const launches = new Map<string, LaunchState>();
  // The marker transitions of one nonce: the acknowledgement, the disposal
  // and the recovery of this agent write through one chain, so a marker is
  // never written twice at the same time.
  const chains = new Map<string, Promise<void>>();
  // The generation of the recovery obligation: it grows whenever an
  // obligation is registered. A round that captured an older generation
  // never cancels the timer of a newer obligation.
  let obligationGeneration = 0;
  let recoveryTimer: unknown;
  let closed = false;
  // The continuation of the label sweep: the last id the previous round
  // reached. The next round starts after it, so a listing that holds more
  // ids than one batch never starves the ids behind it.
  let sweepCursor: string | undefined;
  // The item the sweep cursor is held at: the id a deadline interrupted
  // and the number of consecutive rounds it was interrupted.
  const sweepHold: CursorHold = newCursorHold();
  // The continuation of the marker pass: the last marker the previous round
  // processed. The next round starts after it.
  let markerCursor: string | undefined;
  // The marker the marker cursor is held at: the path a deadline
  // interrupted and the number of consecutive rounds it was interrupted.
  const markerHold: CursorHold = newCursorHold();
  // The number of the recovery rounds of this manager: it decides which
  // pass runs first in the next round. The passes alternate, so neither
  // one can starve the other under the shared deadline of a round.
  let roundNumber = 0;

  // The probes of one round: the verdict of every owner is cached for the
  // round, so one probe per owner decides the round. The owners of a
  // batch are probed at the same time.
  const createRoundProbes = (): RoundProbes => {
    const cache: ProbeCache = new Map();
    return {
      async of(owner: string) {
        const cached = cache.get(owner);
        if (cached) return cached;
        const outcome = await probeBridge(
          installId,
          owner,
          probeTimeoutMs,
          options,
        );
        cache.set(owner, outcome);
        return outcome;
      },
      async batch(owners: readonly string[]) {
        await probeOwners(installId, owners, cache, probeTimeoutMs, options);
      },
    };
  };

  // The deadline of the commands of one round: it aborts the signal when
  // the budget of the round ends. The bound is a timer of the clock of the
  // owner, so a test drives it with virtual time.
  const commandSignal = () => {
    const controller = new AbortController();
    const handle = options.setTimer(
      () => controller.abort(),
      COMMAND_TIMEOUT_MS,
    );
    return {
      signal: controller.signal,
      cancel: () => options.clearTimer(handle),
    };
  };

  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const handle = options.setTimer(() => {
        options.clearTimer(handle);
        resolve();
      }, ms);
    });

  async function ensureDirectory(path: string) {
    await assertNoLinks(path, true);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertNoLinks(path);
  }

  // The marker is created once, exclusively, and every rewrite goes through
  // a temporary file in the same folder.
  async function createMarker(path: string, marker: DockerMarker) {
    await assertNoLinks(path, true);
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(marker));
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async function rewriteMarker(path: string, marker: DockerMarker) {
    await assertNoLinks(path, true);
    const temporary = join(
      dirname(path),
      `${TEMPORARY_MARKER}${randomUUID()}.tmp`,
    );
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(marker));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  // The deletion of a marker: a missing marker is already gone, every
  // other failure is a doubt that the recovery resolves.
  async function deleteMarker(path: string) {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
  }

  // The container id file of one session, below the folder of its bridge.
  const cidfileOf = (owner: string, nonce: string) =>
    join(root, agentId, owner, CID_FOLDER, `${nonce}.cid`);

  // The removal of a container id file whose marker is gone: the file is
  // never evidence of ownership. A path that holds a link is never touched,
  // and that is no failure: no later round could remove it either. It
  // answers false when the file could stay behind for another reason: the
  // recovery then keeps a round scheduled for it.
  async function discardCidfile(path: string): Promise<boolean> {
    try {
      await assertNoLinks(path, true);
    } catch (error) {
      return error instanceof HubError && error.code === 'conflict';
    }
    try {
      await unlink(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  // The removal of a folder of a finished bridge: only an empty folder
  // without a link goes, everything else stays.
  async function removeEmptyFolder(path: string) {
    try {
      await assertNoLinks(path);
      await rmdir(path);
    } catch {
      // A folder that is not empty, or that cannot be checked, stays.
    }
  }

  // The purge of the artifacts of finished sessions: the container id file
  // of a session whose marker is gone, and the folders of a bridge that
  // probes absent once they are empty. It reads only the marker folder of
  // this agent, it never removes a marker and it never follows a link. The
  // folders of this bridge stay: its next launch writes into them.
  //
  // The purge walks the sorted bridge folders in passes. One round examines
  // at most PURGE_BATCH_SIZE folders and PURGE_FILE_BUDGET files, and it
  // stops at the deadline of the round. The cursors keep the place it
  // reached: the last folder it finished, and the last file of the folder
  // it was cut in. The next round resumes there, so a large folder never
  // starts again from its first file. The purge answers false while its
  // pass is unfinished, and at the end of a pass that left a file behind:
  // the recovery keeps a round scheduled for the rest, and the next pass
  // examines that file again.
  let purgeCursor: string | undefined;
  let purgeFileCursor: { owner: string; name: string } | undefined;
  let purgeLeftFile = false;
  // The end of a pass: it answers whether the pass removed every file it
  // had to.
  const endPurgePass = () => {
    purgeCursor = undefined;
    purgeFileCursor = undefined;
    const clean = !purgeLeftFile;
    purgeLeftFile = false;
    return clean;
  };
  async function purgeArtifacts(
    probes: RoundProbes,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const agentRoot = join(root, agentId);
    const bridges = await readFolder(agentRoot);
    // A missing folder of the agent holds nothing to purge. An unreadable
    // one may: the pass stays unfinished, so the recovery keeps a round
    // scheduled for it.
    if (bridges.kind === 'missing') return endPurgePass();
    if (bridges.kind === 'unreadable') return false;
    const owners = bridges.entries
      .filter((entry) => entry.isDirectory() && lowerUuid.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    // The batch of this round never wraps: the pass ends at the last folder
    // and the next pass starts again at the first one.
    const cursor = purgeCursor;
    const batch = owners
      .filter((owner) => cursor === undefined || owner > cursor)
      .slice(0, PURGE_BATCH_SIZE);
    if (batch.length === 0) return endPurgePass();
    // The other owners of the batch are probed at the same time: the slow
    // owners cost one probe bound, not one bound each.
    await probes.batch(batch.filter((owner) => owner !== bridgeId));
    let budget = PURGE_FILE_BUDGET;
    for (const owner of batch) {
      // The deadline of the round expired: a later round continues here.
      if (signal.aborted) return false;
      const own = owner === bridgeId;
      // Only this bridge and a bridge that probes absent own artifacts of
      // finished sessions.
      if (own || (await probes.of(owner)) === 'absent') {
        const folder = join(agentRoot, owner);
        const cidFolder = join(folder, CID_FOLDER);
        const files = await readFolder(cidFolder);
        // An unreadable folder may hold files this pass could not reach.
        if (files.kind === 'unreadable') purgeLeftFile = true;
        // The folder was cut in a previous round: its files up to the file
        // cursor are done.
        const after =
          purgeFileCursor?.owner === owner ? purgeFileCursor.name : undefined;
        const names =
          files.kind === 'entries'
            ? files.entries
                .filter((file) => file.isFile() && file.name.endsWith('.cid'))
                .map((file) => file.name)
                .filter((name) => after === undefined || name > after)
                .sort()
            : [];
        for (const name of names) {
          // The round ran out of its deadline or of its file budget: the
          // file cursor keeps the place for the next round.
          if (signal.aborted || budget === 0) return false;
          budget -= 1;
          const nonce = name.slice(0, -'.cid'.length);
          // A launch of this bridge still owns its file, and a file with an
          // unexpected name is left alone.
          if (lowerUuid.test(nonce) && !(own && launches.has(nonce))) {
            // Only a confirmed missing marker lets the file of its session go.
            const marker = await markerExists(join(folder, `${nonce}.json`));
            // An interrupted check leaves the file cursor before this file,
            // so the next round checks it again.
            if (signal.aborted) return false;
            if (
              marker === 'absent' &&
              !(await discardCidfile(cidfileOf(owner, nonce)))
            )
              purgeLeftFile = true;
          }
          purgeFileCursor = { owner, name };
        }
        if (!own && !signal.aborted) {
          await removeEmptyFolder(cidFolder);
          await removeEmptyFolder(folder);
        }
        if (signal.aborted) return false;
      }
      // The folder is finished: the next round starts after it.
      purgeCursor = owner;
      purgeFileCursor = undefined;
    }
    // The pass is over once the batch reached the last folder.
    const finished = batch[batch.length - 1] === owners[owners.length - 1];
    return finished ? endPurgePass() : false;
  }

  // The marker transitions of one nonce are serialized: a transition waits
  // for the previous one, and a failed write does not break the next one.
  function transition(
    nonce: string,
    write: () => Promise<void>,
  ): Promise<void> {
    const previous = chains.get(nonce) ?? Promise.resolve();
    const next = previous.then(write, write);
    // The chain never rejects: a failed write does not break the next one.
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    chains.set(nonce, settled);
    // A finished chain leaves no promise behind.
    void settled.then(() => {
      if (chains.get(nonce) === settled) chains.delete(nonce);
    });
    return next;
  }

  // The pause point of one transition.
  async function pause(nonce: string, phase: DockerMarkerPhase) {
    await options.pauseTransition?.(nonce, phase);
  }

  // The record of a removal: the marker moves to `removing` with the
  // inspected id and the daemon that holds it. A marker that exists and
  // cannot be read is uncertain cleanup: the removal is never recorded, so
  // the container that it names stays. A marker whose existence cannot be
  // checked is the same doubt: the removal is refused.
  async function recordRemoving(
    path: string,
    nonce: string,
    id: string,
    daemon: string,
  ): Promise<void> {
    await transition(nonce, async () => {
      await pause(nonce, 'removing');
      const marker = await readMarkerFile(path);
      if (!marker) {
        // Only a confirmed missing marker lets the removal go unrecorded.
        if ((await markerExists(path)) !== 'absent') throw new Error();
        return;
      }
      await rewriteMarker(path, {
        ...marker,
        phase: 'removing',
        containerId: id,
        daemonId: daemon || marker.daemonId,
      });
    });
  }

  async function daemonId(signal?: AbortSignal): Promise<string | undefined> {
    // A caller without a signal gets the bound of one command.
    const budget = signal ? undefined : commandSignal();
    const command = signal ?? budget?.signal;
    if (!command) return undefined;
    try {
      const value = (
        await docker.run(['info', '--format', '{{.ID}}'], command)
      ).trim();
      return value || undefined;
    } catch {
      return undefined;
    } finally {
      budget?.cancel();
    }
  }

  // The endpoint the Docker profile pinned for this command.
  const endpoint = () => docker.environment.DOCKER_HOST ?? '';

  // The image pre-flight: the common failure happens before any marker.
  async function preflight(image: string, signal: AbortSignal) {
    try {
      await docker.run(['image', 'inspect', image], signal);
      return;
    } catch {
      // The image is missing: it is pulled in a separate CLI run.
    }
    await docker.run(['pull', image], signal, 600_000);
  }

  // The ownership evidence of one container: the installation, the agent,
  // the session, the connector and the bridge that owns it.
  function ownsLabels(
    labels: Record<string, string>,
    expected: Record<string, string>,
  ): boolean {
    for (const [key, value] of Object.entries(expected))
      if (labels[key] !== value) return false;
    return true;
  }

  // The owner of an inspected container is authorised in exactly two cases:
  // the owning bridge probes absent, or the owner is this bridge and its
  // nonce belongs to no live entry of this bridge. A probe that cannot
  // decide leaves the ownership uncertain.
  type OwnerVerdict = 'authorised' | 'refused' | 'unknown';

  async function authorise(
    owner: string,
    nonce: string,
    probeOf: (bridgeId: string) => Promise<ProbeOutcome>,
  ): Promise<OwnerVerdict> {
    if (!lowerUuid.test(owner)) return 'refused';
    if (owner === bridgeId) return live.has(nonce) ? 'refused' : 'authorised';
    const outcome = await probeOf(owner);
    if (outcome === 'absent') return 'authorised';
    if (outcome === 'unknown') return 'unknown';
    return 'refused';
  }

  // The verified removal of one container: the immutable id is inspected,
  // every ownership label is confirmed, the removal is recorded, the
  // container is removed and its absence is confirmed.
  async function removeVerified(
    id: string,
    expected: Record<string, string>,
    removal: { signal: AbortSignal; record?: () => Promise<void> },
  ): Promise<boolean> {
    try {
      await removeInspectedContainer(docker, id, expected, {
        signal: removal.signal,
        ...(removal.record ? { record: removal.record } : {}),
      });
      return true;
    } catch {
      // The marker stays: the recovery resolves it later.
      return false;
    }
  }

  // The outcome of one item of a pass: 'settled' means the item was
  // processed and the pass may move past it, 'incomplete' means its work
  // finished but the pass could not examine it, and 'interrupted' means
  // the deadline of the round cut it short. An interrupted item is never
  // passed: the next round starts at it again. A deadline that interrupts
  // the same item in two consecutive rounds defers it: the cursor moves
  // past it, the round stays incomplete and the item is examined again
  // after the cursor wraps.
  type ItemOutcome = 'settled' | 'incomplete' | 'interrupted';

  // The label sweep of the current daemon: only the containers of this
  // installation and this agent are listed, and only the ones whose owner
  // is gone (or whose own nonce belongs to no live entry) are removed. It
  // reports whether every listed container could be examined: an
  // incomplete sweep keeps the recovery armed, because a container it
  // could not examine may still belong to this agent. A listing is read in
  // batches of SWEEP_BATCH_SIZE ids: the cursor of the agent holds the
  // last id the previous round completed, so the next round continues
  // where this one stopped. A container the deadline always interrupts
  // would hold the cursor forever, so it is deferred after two rounds:
  // the cursor moves past it and it is examined again after the cursor
  // wraps.
  async function labelSweep(
    inventory: MarkerInventory,
    current: string,
    probes: RoundProbes,
    signal: AbortSignal,
    failed: Set<string>,
  ): Promise<boolean> {
    // An incomplete inventory is never read as "no marker": while the
    // inventory of the agent is uncertain, the sweep removes nothing.
    if (inventory.uncertain) return false;
    let listed: string;
    try {
      listed = await docker.run(
        [
          'ps',
          '--all',
          '--quiet',
          '--no-trunc',
          '--filter',
          `label=wmh.install=${installId}`,
          '--filter',
          `label=wmh.agent=${agentId}`,
        ],
        signal,
      );
    } catch {
      // The listing failed: the sweep is incomplete.
      return false;
    }
    const ids = parseListing(listed);
    // A malformed listing is never read as "no container".
    if (!ids) return false;
    // Nothing to sweep: the continuation starts over.
    if (ids.length === 0) {
      sweepCursor = undefined;
      releaseHold(sweepHold);
      return true;
    }
    // A held item that the listing does not hold any more is gone: its
    // hold is stale and the cursor is free.
    if (sweepHold.item !== undefined && !ids.includes(sweepHold.item))
      releaseHold(sweepHold);
    // The round continues after the id the previous round completed.
    const batch = batchOf(ids, sweepCursor, SWEEP_BATCH_SIZE);
    let complete = true;
    for (const id of batch) {
      // The deadline of the round expired: the sweep stops here and the
      // next round resumes at this id.
      if (signal.aborted) {
        complete = false;
        break;
      }
      // The deadline interrupted this item in two consecutive rounds: the
      // cursor moves past it and the item is examined again after the
      // cursor wraps. The deferral never removes an item.
      if (holdDeferred(sweepHold, id)) {
        sweepCursor = id;
        releaseHold(sweepHold);
        // The round stays incomplete: the deferred item is still owed.
        complete = false;
        continue;
      }
      const outcome = await sweepItem(
        id,
        inventory,
        current,
        probes,
        signal,
        failed,
      );
      if (outcome === 'interrupted') {
        // The deadline cut this item short: the cursor is held at it and
        // the next round starts at it again.
        holdInterrupted(sweepHold, id);
        complete = false;
        break;
      }
      // The item is done: the continuation moves past it.
      sweepCursor = id;
      // An item that settles releases the hold of the cursor.
      if (sweepHold.item === id) releaseHold(sweepHold);
      if (outcome === 'incomplete') complete = false;
    }
    // A batch that does not cover every listed id leaves the sweep
    // incomplete: the next round continues where this one stopped.
    if (batch.length < ids.length) complete = false;
    return complete;
  }

  // The examination of one container of the label sweep: the ownership
  // labels are confirmed, the owner of the container decides the removal
  // and the container is removed by its immutable id.
  async function sweepItem(
    id: string,
    inventory: MarkerInventory,
    current: string,
    probes: RoundProbes,
    signal: AbortSignal,
    failed: Set<string>,
  ): Promise<ItemOutcome> {
    // A removal that failed in this round is not tried again by it.
    if (failed.has(id)) return 'settled';
    const labels = await inspectContainerLabels(docker, id, signal);
    if (!labels) {
      // The container could not be inspected: the sweep is incomplete.
      return signal.aborted ? 'interrupted' : 'incomplete';
    }
    // The deadline of the round expired while the container was read.
    if (signal.aborted) return 'interrupted';
    if (labels['wmh.install'] !== installId || labels['wmh.agent'] !== agentId)
      return 'settled';
    const owner = labels['wmh.bridge'];
    const nonce = labels['wmh.client'];
    const connector = labels['wmh.connector'];
    if (!owner || !lowerUuid.test(owner) || !nonce || !connector)
      return 'settled';
    const verdict = await authorise(owner, nonce, probes.of);
    // The deadline of the round expired while the owner was probed.
    if (signal.aborted) return 'interrupted';
    if (verdict === 'unknown') {
      // The owner could not be probed: the sweep is incomplete.
      return 'incomplete';
    }
    if (verdict !== 'authorised') return 'settled';
    // The marker of this session: a marker that cannot record the removal
    // keeps its container, and a marker of another daemon is uncertain
    // cleanup that is kept.
    const matches = inventory.entries.filter((item) => item.nonce === nonce);
    if (matches.length > 1) return 'settled';
    const entry = matches[0];
    if (entry) {
      // The marker of this session belongs to the owner of the container.
      if (entry.bridgeId !== owner) return 'settled';
      if (!entry.marker || !entry.bound) return 'settled';
      if (entry.marker.connectorId !== connector) return 'settled';
      if (entry.marker.daemonId !== current) return 'settled';
    }
    const removed = await removeVerified(
      id,
      {
        'wmh.install': installId,
        'wmh.agent': agentId,
        'wmh.client': nonce,
        'wmh.connector': connector,
        'wmh.bridge': owner,
      },
      {
        signal,
        ...(entry
          ? {
              record: () =>
                recordRemoving(entry.path, entry.nonce, id, current),
            }
          : {}),
      },
    );
    if (!removed) {
      failed.add(id);
      // The deadline of the round expired while the container was removed.
      return signal.aborted ? 'interrupted' : 'settled';
    }
    if (!entry) return 'settled';
    try {
      await deleteMarker(entry.path);
    } catch {
      // The marker that cannot be deleted is owed to the recovery.
      scheduleRecovery();
    }
    return 'settled';
  }

  // The marker pass: the markers of an authorised owner are resolved. A
  // daemon mismatch, a `launching` marker and an unparsable marker are kept.
  // The pass reads the markers in batches of MARKER_BATCH_SIZE and
  // continues after the marker the previous round completed, so an
  // expensive prefix cannot consume every round. A marker the deadline
  // always interrupts would hold the cursor forever, so it is deferred
  // after two rounds: the cursor moves past it and it is examined again
  // after the cursor wraps. The owners of the batch are probed before the
  // batch is processed: their probes run at the same time, so the slow
  // owners of a batch cost one probe bound instead of one bound each.
  async function markerPass(
    inventory: MarkerInventory,
    current: string,
    probes: RoundProbes,
    signal: AbortSignal,
    failed: Set<string>,
  ): Promise<boolean> {
    // An incomplete inventory is never read as "every marker": while the
    // inventory of the agent is uncertain, the pass resolves nothing.
    if (inventory.uncertain) return false;
    // The markers of the agent in a stable order: the continuation of the
    // round needs it.
    const entries = [...inventory.entries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    // Nothing to resolve: the continuation starts over.
    if (entries.length === 0) {
      markerCursor = undefined;
      releaseHold(markerHold);
      return true;
    }
    // A held marker that the inventory does not hold any more is gone: its
    // hold is stale and the cursor is free.
    if (
      markerHold.item !== undefined &&
      !entries.some((entry) => entry.path === markerHold.item)
    )
      releaseHold(markerHold);
    const start = resumeIndex(
      entries.map((entry) => entry.path),
      markerCursor,
    );
    const count = Math.min(MARKER_BATCH_SIZE, entries.length);
    // The owners of the batch: the markers that name a container of this
    // daemon and that the pass could resolve. Their probes run at the
    // same time, so a batch of slow owners costs one probe bound.
    const owners: string[] = [];
    for (let offset = 0; offset < count; offset++) {
      const entry = entries[(start + offset) % entries.length];
      if (!entry) break;
      const marker = entry.marker;
      if (!marker || !entry.bound) continue;
      if (marker.daemonId !== current) continue;
      if (marker.phase === 'launching') continue;
      const id = marker.containerId;
      if (!id || !containerId.test(id)) continue;
      owners.push(marker.bridgeId);
    }
    if (!signal.aborted) await probes.batch(owners);
    let complete = true;
    for (let offset = 0; offset < count; offset++) {
      const entry = entries[(start + offset) % entries.length];
      if (!entry) break;
      // The deadline of the round expired: the pass stops here and the
      // next round resumes at this marker.
      if (signal.aborted) {
        complete = false;
        break;
      }
      // The deadline interrupted this marker in two consecutive rounds: the
      // cursor moves past it and the marker is examined again after the
      // cursor wraps. The deferral never deletes a marker.
      if (holdDeferred(markerHold, entry.path)) {
        markerCursor = entry.path;
        releaseHold(markerHold);
        // The pass stays incomplete: the deferred marker is still owed.
        complete = false;
        continue;
      }
      const outcome = await markerItem(entry, current, probes, signal, failed);
      if (outcome === 'interrupted') {
        // The deadline cut this marker short: the cursor is held at it and
        // the next round starts at it again.
        holdInterrupted(markerHold, entry.path);
        complete = false;
        break;
      }
      // The marker is done: the continuation moves past it.
      markerCursor = entry.path;
      // A marker that settles releases the hold of the cursor.
      if (markerHold.item === entry.path) releaseHold(markerHold);
    }
    // A batch that does not cover every marker leaves the pass incomplete:
    // the next round continues where this one stopped.
    if (count < entries.length) complete = false;
    return complete;
  }

  // The resolution of one marker of the marker pass: the container of the
  // marker is inspected, the owner of that container decides the removal
  // and the marker is deleted once its container is gone.
  async function markerItem(
    entry: MarkerEntry,
    current: string,
    probes: RoundProbes,
    signal: AbortSignal,
    failed: Set<string>,
  ): Promise<ItemOutcome> {
    const marker = entry.marker;
    if (!marker || !entry.bound) return 'settled';
    if (marker.daemonId !== current) return 'settled';
    if (marker.phase === 'launching') return 'settled';
    const id = marker.containerId;
    if (!id || !containerId.test(id)) return 'settled';
    if (failed.has(id)) return 'settled';
    const labels = await inspectContainerLabels(docker, id, signal);
    // The deadline of the round expired while the container was read.
    if (signal.aborted) return 'interrupted';
    if (labels) {
      // The owner of the inspected container decides the removal, not the
      // bridge that wrote the marker.
      const owner = labels['wmh.bridge'];
      if (!owner || !lowerUuid.test(owner)) return 'settled';
      if (labels['wmh.client'] !== marker.nonce) return 'settled';
      if ((await authorise(owner, marker.nonce, probes.of)) !== 'authorised')
        return 'settled';
      // The deadline of the round expired while the owner was probed.
      if (signal.aborted) return 'interrupted';
      const removed = await removeVerified(
        id,
        {
          'wmh.install': installId,
          'wmh.agent': agentId,
          'wmh.client': marker.nonce,
          'wmh.connector': marker.connectorId,
          'wmh.bridge': owner,
        },
        {
          signal,
          record: () => recordRemoving(entry.path, entry.nonce, id, current),
        },
      );
      if (!removed) {
        failed.add(id);
        // The deadline of the round expired while the container was
        // removed.
        return signal.aborted ? 'interrupted' : 'settled';
      }
      try {
        await deleteMarker(entry.path);
      } catch {
        // The marker that cannot be deleted is owed to the recovery.
        scheduleRecovery();
      }
      return 'settled';
    }
    // The container is gone: its absence is confirmed on the recorded
    // daemon before the marker is deleted.
    let listed: string | undefined;
    try {
      listed = await docker.run(
        ['ps', '--all', '--quiet', '--no-trunc', '--filter', `id=${id}`],
        signal,
      );
    } catch {
      listed = undefined;
    }
    // The deadline of the round expired while the absence was confirmed.
    if (signal.aborted) return 'interrupted';
    if (listed === undefined || listed.trim()) return 'settled';
    try {
      await deleteMarker(entry.path);
    } catch {
      // The marker that cannot be deleted is owed to the recovery.
      scheduleRecovery();
    }
    return 'settled';
  }

  // The recovery timer: it is armed while an obligation exists, and it is
  // armed again after every failed round, every contention and every failed
  // disposal. Every registration of a duty grows the obligation
  // generation: a round that took its snapshot before the duty was
  // registered never cancels the timer of that duty.
  function scheduleRecovery() {
    obligationGeneration += 1;
    if (closed) return;
    if (recoveryTimer !== undefined) return;
    recoveryTimer = options.setTimer(() => {
      recoveryTimer = undefined;
      void recover().catch(() => undefined);
    }, recoveryIntervalMs);
  }

  // The recovery obligation of the agent: it lasts as long as a marker of a
  // bridge that is not live, or of a nonce that belongs to no live entry of
  // this bridge, exists, and as long as a pass of the round is unfinished:
  // the marker pass, the label sweep or the artifact purge stopped before
  // its end. A round only cancels the timer when no obligation
  // was registered since its snapshot: an obligation of a disposal or a
  // launch that ran while the round worked survives the round.
  async function armRecovery(
    inventory: MarkerInventory,
    probeOf: (bridgeId: string) => Promise<ProbeOutcome>,
    generation: number,
    passesComplete: boolean,
  ) {
    let obligation = inventory.uncertain || !passesComplete;
    for (const entry of inventory.entries) {
      if (obligation) break;
      if (!entry.marker || !entry.bound) {
        obligation = true;
        break;
      }
      if (entry.marker.bridgeId === bridgeId) {
        if (!live.has(entry.marker.nonce)) {
          obligation = true;
          break;
        }
        continue;
      }
      if ((await probeOf(entry.marker.bridgeId)) !== 'live') {
        obligation = true;
        break;
      }
    }
    if (obligation) {
      scheduleRecovery();
      return;
    }
    // An obligation that was registered while this round worked keeps its
    // timer: the round never cancels a duty it did not see.
    if (generation !== obligationGeneration) return;
    if (recoveryTimer !== undefined) {
      options.clearTimer(recoveryTimer);
      recoveryTimer = undefined;
    }
  }

  // The rounds that are running: the shutdown waits for them, so a round is
  // never cut while it removes a container or a marker.
  const rounds = new Set<Promise<void>>();

  function recover(): Promise<void> {
    if (closed) return Promise.resolve();
    const round = recoverRound();
    rounds.add(round);
    void round.finally(() => rounds.delete(round)).catch(() => undefined);
    return round;
  }

  // The rounds are awaited again until none runs: a round that started
  // while the previous ones finished is awaited too. Once the manager is
  // closed no round starts, so the wait ends.
  async function settled() {
    while (rounds.size > 0) await Promise.allSettled([...rounds]);
  }

  async function recoverRound() {
    if (closed) return;
    const lock = await acquireRecovery(installId, agentId);
    // Another recoverer holds the mutex: this round is skipped and the next
    // one is scheduled.
    if (!lock) {
      scheduleRecovery();
      return;
    }
    try {
      // The deadline of the round: it expires with the budget of the
      // commands, and the passes stop at that point.
      const budget = commandSignal();
      try {
        const signal = budget.signal;
        const current = await daemonId(signal);
        if (!current) {
          // The daemon is unavailable: every marker is uncertain cleanup.
          scheduleRecovery();
          return;
        }
        // The verdict of every owner is cached for the round: one probe
        // per owner per round. The owners of a batch are probed at the
        // same time, so the slow owners of a batch cost one probe bound.
        const probes: RoundProbes = createRoundProbes();
        // The generation of the obligation when this round started: a duty
        // that was registered while the round worked keeps its timer.
        const generation = obligationGeneration;
        // One inventory of the agent: the passes and the recovery obligation
        // read the same one, so an incomplete inventory is never read as
        // "no marker".
        const inventory = await readMarkerInventory(root, agentId);
        // A removal that failed in this round is not tried again by it.
        const failed = new Set<string>();
        // The passes of a round share one deadline, so they alternate
        // their order: the marker pass runs first on the odd rounds and
        // the label sweep on the even ones. A pass that the deadline cuts
        // never starves the other one.
        roundNumber += 1;
        let markers: boolean;
        let swept: boolean;
        if (roundNumber % 2 === 1) {
          markers = await markerPass(
            inventory,
            current,
            probes,
            signal,
            failed,
          );
          swept = await labelSweep(inventory, current, probes, signal, failed);
        } else {
          swept = await labelSweep(inventory, current, probes, signal, failed);
          markers = await markerPass(
            inventory,
            current,
            probes,
            signal,
            failed,
          );
        }
        // The artifacts of finished sessions go once the passes are done. An
        // uncertain inventory keeps everything, and it is an obligation of
        // its own. A purge whose pass is unfinished, or that left a file
        // behind, is an obligation: the next round continues it. A purge
        // that fails never fails the round, but it is an obligation too.
        const purged = inventory.uncertain
          ? true
          : await purgeArtifacts(probes, signal).catch(() => false);
        await armRecovery(
          inventory,
          probes.of,
          generation,
          markers && swept && purged,
        );
        // A removal that failed in this round is owed to the next one.
        if (failed.size > 0) scheduleRecovery();
      } finally {
        budget.cancel();
      }
    } catch {
      // A failed round keeps the obligation: the next round is scheduled.
      scheduleRecovery();
    } finally {
      await lock.close();
    }
  }

  // The launch state of a finished launch is released: it keeps no promise
  // and no marker transition behind.
  function releaseLaunch(nonce: string) {
    launches.delete(nonce);
  }

  // The durable flag of the agent: it is written once, exclusively, and it
  // is never deleted. It tells a later bridge that this agent could hold a
  // labelled container even when every marker is gone. A flag that cannot
  // be written, or that exists and is not a plain file, is a doubt: the
  // admission is refused, because a labelled container of this agent could
  // survive without a marker.
  async function markDockerUsed() {
    const agentRoot = join(root, agentId);
    const flagPath = join(agentRoot, DOCKER_USED);
    try {
      await ensureDirectory(agentRoot);
      const file = await open(flagPath, 'wx', 0o600);
      await file.close();
      return;
    } catch (error) {
      // Only an existing flag is read again: every other failure refuses
      // the admission.
      if (errorCode(error) !== 'EEXIST')
        throw new RuntimeFault('dependency_unavailable');
    }
    try {
      await assertNoLinks(flagPath);
      const info = await lstat(flagPath);
      if (!info.isFile()) throw new Error();
    } catch {
      throw new RuntimeFault('dependency_unavailable');
    }
  }

  return {
    bridgeId,
    installId,
    get retainedLaunches() {
      return launches.size;
    },
    async admit() {
      await recover();
      const current = await daemonId();
      const inventory = await readMarkerInventory(root, agentId);
      if (await hasLegacyMarkers(root))
        throw new RuntimeFault('dependency_unavailable');
      // An uncertain marker blocks this agent until it is resolved: a
      // marker that does not parse, a marker of another daemon, a removal
      // that did not finish and a running marker that no round resolved.
      let uncertain = inventory.uncertain;
      for (const entry of inventory.entries) {
        if (uncertain) break;
        if (!entry.marker || !entry.bound) {
          uncertain = true;
          break;
        }
        if (entry.marker.daemonId !== current) {
          uncertain = true;
          break;
        }
        if (entry.marker.phase === 'removing') {
          uncertain = true;
          break;
        }
        if (entry.marker.phase !== 'running') continue;
        if (entry.marker.bridgeId === bridgeId) {
          // An abandoned peer of this bridge: its nonce belongs to no live
          // entry and no round resolved it.
          if (!live.has(entry.marker.nonce)) uncertain = true;
          continue;
        }
        // The marker of another bridge: only an absent owner leaves an
        // abandoned marker behind.
        if (
          (await probeBridge(
            installId,
            entry.marker.bridgeId,
            probeTimeoutMs,
            options,
          )) === 'absent'
        )
          uncertain = true;
      }
      if (uncertain) throw new RuntimeFault('dependency_unavailable');
      const launching = inventory.entries.filter(
        (entry) => entry.marker?.phase === 'launching',
      ).length;
      if (launching > MAX_LAUNCHING_MARKERS)
        throw new RuntimeFault('dependency_unavailable');
      // The agent admitted a Docker peer: the durable flag lets a later
      // bridge sweep a labelled container of this agent even when no
      // marker is left.
      await markDockerUsed();
    },
    async launch(request, signal) {
      // The image pre-flight: the failure happens before any marker exists.
      await preflight(request.image, signal);
      const current = await daemonId();
      if (!current) throw new RuntimeFault('dependency_unavailable');
      const nonce = randomUUID();
      const folder = join(root, agentId, bridgeId);
      await ensureDirectory(folder);
      await ensureDirectory(join(folder, CID_FOLDER));
      const markerPath = join(folder, `${nonce}.json`);
      const cidfilePath = join(folder, CID_FOLDER, `${nonce}.cid`);
      const marker: DockerMarker = {
        nonce,
        connectorId: request.connectorId,
        agentId,
        bridgeId,
        dockerEndpoint: endpoint(),
        daemonId: current,
        phase: 'launching',
      };
      await createMarker(markerPath, marker);
      const state: LaunchState = {
        nonce,
        connectorId: request.connectorId,
        markerPath,
        cidfilePath,
        stopped: false,
      };
      launches.set(nonce, state);
      const labels = [
        '--label',
        `wmh.install=${installId}`,
        '--label',
        `wmh.agent=${agentId}`,
        '--label',
        `wmh.bridge=${bridgeId}`,
        '--label',
        `wmh.client=${nonce}`,
        '--label',
        `wmh.connector=${request.connectorId}`,
      ];
      try {
        await request.start(labels, cidfilePath);
      } catch (error) {
        // The launch is abandoned: the marker stays `launching` and the
        // recovery owns it from now on. The failed launch keeps no state.
        scheduleRecovery();
        releaseLaunch(nonce);
        throw error;
      }
      live.add(nonce);
      return {
        nonce,
        connectorId: request.connectorId,
        markerPath,
        cidfilePath,
      };
    },
    async watch(launch, signal) {
      const state = launches.get(launch.nonce);
      const deadline = options.now() + watchTimeoutMs;
      const watcher = (async () => {
        for (;;) {
          if (state?.stopped || signal.aborted) return undefined;
          let id: string | undefined;
          try {
            const bytes = await readFile(launch.cidfilePath, 'utf8');
            const value = bytes.trim();
            if (containerId.test(value)) id = value;
          } catch {
            id = undefined;
          }
          if (id) {
            // A peer that is gone never acknowledges its launch.
            if (signal.aborted || state?.stopped) return undefined;
            // The acknowledgement writes through the chain of the nonce
            // and reads the marker inside it: a removal that started
            // first is never undone.
            await transition(launch.nonce, async () => {
              await pause(launch.nonce, 'running');
              // The disposal of the session started while the
              // acknowledgement waited: the marker never returns to
              // `running` behind a recorded removal.
              if (state?.stopped || signal.aborted) return;
              const marker = await readMarkerFile(launch.markerPath);
              if (!marker || marker.phase === 'removing') return;
              await rewriteMarker(launch.markerPath, {
                ...marker,
                phase: 'running',
                containerId: id,
              });
            });
            if (state) state.containerId = id;
            launch.containerId = id;
            return id;
          }
          if (options.now() >= deadline || signal.aborted) return undefined;
          await delay(WATCH_INTERVAL_MS);
        }
      })();
      if (state) state.watcher = watcher;
      return watcher;
    },
    async dispose(launch, signal) {
      const state = launches.get(launch.nonce);
      // The acknowledgement stops and joins before the nonce leaves the
      // live set: a recovery round never treats a pending launch as
      // abandoned while its watcher may still write the marker.
      if (state) {
        state.stopped = true;
        await state.watcher?.catch(() => undefined);
      }
      live.delete(launch.nonce);
      try {
        const marker = await readMarkerFile(launch.markerPath);
        const current = await daemonId(signal);
        // The daemon of the marker must be the daemon of this session: a
        // container of another daemon is never confirmed absent here.
        if (marker && (!current || marker.daemonId !== current)) {
          scheduleRecovery();
          throw new RuntimeFault('dependency_unavailable', true);
        }
        const id =
          launch.containerId ?? state?.containerId ?? marker?.containerId;
        const connectorId = marker?.connectorId ?? launch.connectorId;
        const expected = {
          'wmh.install': installId,
          'wmh.agent': agentId,
          'wmh.client': launch.nonce,
          'wmh.connector': connectorId,
          'wmh.bridge': bridgeId,
        };
        const record = async (inspected: string) => {
          // The removal is recorded before the container is removed.
          await recordRemoving(
            launch.markerPath,
            launch.nonce,
            inspected,
            current ?? '',
          );
        };
        if (id && containerId.test(id)) {
          const labels = await inspectContainerLabels(docker, id, signal);
          if (labels) {
            // Every ownership label must match: a container of another
            // installation, agent or bridge is never removed here.
            if (!ownsLabels(labels, expected)) {
              scheduleRecovery();
              throw new RuntimeFault('dependency_unavailable', true);
            }
            const removed = await removeVerified(id, expected, {
              signal,
              record: () => record(id),
            });
            if (!removed) {
              scheduleRecovery();
              throw new RuntimeFault('dependency_unavailable', true);
            }
          } else {
            // The container is gone: its absence is confirmed before the
            // marker is deleted.
            let listed: string | undefined;
            try {
              listed = await docker.run(
                [
                  'ps',
                  '--all',
                  '--quiet',
                  '--no-trunc',
                  '--filter',
                  `id=${id}`,
                ],
                signal,
              );
            } catch {
              listed = undefined;
            }
            if (listed === undefined || listed.trim()) {
              scheduleRecovery();
              throw new RuntimeFault('dependency_unavailable', true);
            }
            // A `launching` marker is never deleted by an absence: only a
            // recorded removal deletes it.
            if (!marker || marker.phase === 'launching') {
              scheduleRecovery();
              return;
            }
          }
          try {
            await deleteMarker(launch.markerPath);
          } catch (error) {
            // The marker that cannot be deleted is owed to the recovery and
            // the failure is never swallowed.
            scheduleRecovery();
            throw error;
          }
          return;
        }
        // The launch was never acknowledged: the session nonce finds it.
        let removed: boolean;
        try {
          removed = await cleanupOwnedContainers(
            docker,
            launch.nonce,
            connectorId,
            record,
            { signal, expected },
          );
        } catch {
          scheduleRecovery();
          throw new RuntimeFault('dependency_unavailable', true);
        }
        if (!removed) {
          // No container passed through the recorded removal: the marker stays
          // and the recovery owns the session.
          scheduleRecovery();
          return;
        }
        try {
          await deleteMarker(launch.markerPath);
        } catch (error) {
          // The marker that cannot be deleted is owed to the recovery and
          // the failure is never swallowed.
          scheduleRecovery();
          throw error;
        }
      } finally {
        // A marker that is left behind is owed to the recovery, and the
        // launch state is released: the acknowledgement joined and the
        // disposal finished or handed the recovery its marker. Only a
        // marker that is really there is owed to the recovery: a clean
        // disposal removes the container id file of the session, since its
        // marker is gone and nothing reads the file again. Only a file it
        // could not remove is owed to the recovery.
        if ((await markerExists(launch.markerPath)) !== 'absent')
          scheduleRecovery();
        else if (
          lowerUuid.test(launch.nonce) &&
          !(await discardCidfile(cidfileOf(bridgeId, launch.nonce)))
        )
          scheduleRecovery();
        releaseLaunch(launch.nonce);
      }
    },
    recover,
    settled,
    async close() {
      closed = true;
      if (recoveryTimer !== undefined) {
        options.clearTimer(recoveryTimer);
        recoveryTimer = undefined;
      }
    },
  };
}
