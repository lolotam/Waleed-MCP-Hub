import { describe, expect, it, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Connector, HubState } from '@waleed/contracts';
import type { DockerCommand } from '../packages/hub-core/src/adapters/docker-profile.js';
import type {
  ProcessRequest,
  ProcessRunner,
} from '../packages/hub-core/src/ports.js';
import {
  acquireRecovery,
  createDockerOwnership,
  createDockerRuntimeOnce,
  listenBridge,
  pipeName,
  probeBridge,
  settleWithin,
  startDockerRecovery,
  type DockerOwnership,
} from '../packages/hub-core/src/integrations/docker-ownership.js';
import {
  connectDockerPeer,
  createAgentBridge,
  createBridgeDockerRuntime,
  createBridgeStartupRecovery,
  createStartupRecoveryRetry,
  type BridgeConnect,
  type BridgeSession,
  type ShutdownBudget,
} from '../packages/hub-core/src/integrations/bridge.js';
import {
  dockerAgentTransport,
  type DockerSession,
} from '../packages/hub-core/src/integrations/docker-transport.js';
import { ensureInstallRecord } from '../packages/hub-core/src/runtime/boot.js';
import { createSessionPool } from '../packages/hub-core/src/integrations/session-pool.js';
import { profileState } from './helpers/runtime.js';

// The marker deletion of one test fails with a permission error: the guard
// names the file that the file system refuses to delete.
// The hook of one test runs after every deletion that succeeded.
const unlinkGuard = vi.hoisted(() => ({
  path: undefined as string | undefined,
  after: undefined as ((path: string) => void) | undefined,
}));
// The durable flag of one test cannot be written: the guard names the file
// that the file system refuses to create.
const openGuard = vi.hoisted(() => ({
  path: undefined as string | undefined,
}));
// The marker of one test cannot be inspected: the guard names the file whose
// existence the file system refuses to answer.
const lstatGuard = vi.hoisted(() => ({
  path: undefined as string | undefined,
  after: undefined as ((path: string) => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const unlink = async (path: string, ...rest: unknown[]) => {
    if (unlinkGuard.path !== undefined && String(path) === unlinkGuard.path) {
      const error = new Error(
        'synthetic deletion failure',
      ) as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    await (actual.unlink as unknown as (...args: unknown[]) => Promise<void>)(
      path,
      ...rest,
    );
    unlinkGuard.after?.(String(path));
  };
  const open = async (path: string, ...rest: unknown[]) => {
    if (openGuard.path !== undefined && String(path) === openGuard.path) {
      const error = new Error(
        'synthetic creation failure',
      ) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return (actual.open as unknown as (...args: unknown[]) => Promise<unknown>)(
      path,
      ...rest,
    );
  };
  const lstat = async (path: string, ...rest: unknown[]) => {
    if (lstatGuard.path !== undefined && String(path) === lstatGuard.path) {
      const error = new Error(
        'synthetic inspection failure',
      ) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    try {
      return await (
        actual.lstat as unknown as (...args: unknown[]) => Promise<unknown>
      )(path, ...rest);
    } finally {
      lstatGuard.after?.(String(path));
    }
  };
  return { ...actual, unlink, open, lstat };
});

// The pool never reads a real clock: every timer is listed and fired by hand.
class FakeClock {
  private current = 1_700_000_000_000;
  private next = 1;
  readonly timers = new Map<
    number,
    { at: number; delay: number; callback: () => void }
  >();

  readonly now = () => this.current;
  readonly setTimer = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.current + ms, delay: ms, callback });
    return id;
  };
  readonly clearTimer = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  advance(ms: number) {
    const target = this.current + ms;
    for (;;) {
      let due: { at: number; delay: number; callback: () => void } | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at > target) continue;
        if (!due || timer.at < due.at) due = timer;
      }
      if (!due) break;
      for (const [id, timer] of this.timers)
        if (timer === due) this.timers.delete(id);
      this.current = due.at;
      due.callback();
    }
    this.current = target;
  }
}

// An in-memory daemon: containers with their immutable ids and their labels,
// one daemon identity, scripted failures and containers that appear late.
class FakeDaemon implements DockerCommand {
  executable = 'C:\\Synthetic\\docker.exe';
  environment: Record<string, string> = {
    DOCKER_HOST: 'npipe:////./pipe/docker_engine',
  };
  daemon = 'DAEMON-A';
  images = new Set(['synthetic-image:1.2.3']);
  containers = new Map<string, Record<string, string>>();
  calls: string[][] = [];
  private failures: Array<{
    match: (args: readonly string[]) => boolean;
    times: number;
  }> = [];
  // The number of empty listings the daemon answers before it shows a
  // container that appeared late.
  emptyListings = 0;
  // The gate of the listing of the label sweep: the test interleaves a
  // launch with a slow recovery round.
  sweepGate: (() => Promise<void>) | undefined;
  // The cost of one inspection: the test drives it with the virtual
  // time of its clock.
  onInspect: ((id: string) => void) | undefined;

  fail(match: (args: readonly string[]) => boolean, times = 1) {
    this.failures.push({ match, times });
    return this;
  }
  add(id: string, labels: Record<string, string>) {
    this.containers.set(id, labels);
    return id;
  }
  private matches(id: string, filter: string) {
    if (filter.startsWith('id=')) return id === filter.slice(3);
    const [key = '', ...rest] = filter.slice('label='.length).split('=');
    return this.containers.get(id)?.[key] === rest.join('=');
  }
  async run(args: readonly string[], signal?: AbortSignal): Promise<string> {
    this.calls.push([...args]);
    // A command of an expired budget never runs.
    if (signal?.aborted) throw new Error('synthetic aborted command');
    for (const failure of this.failures)
      if (failure.times > 0 && failure.match(args)) {
        failure.times -= 1;
        throw new Error('synthetic docker failure');
      }
    if (args[0] === 'info') return this.daemon;
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!this.images.has(args[2] ?? '')) throw new Error('no such image');
      return '[]';
    }
    if (args[0] === 'pull') {
      this.images.add(args[1] ?? '');
      return 'pulled';
    }
    if (args[0] === 'ps') {
      // Only the label sweep of the installation is empty: the confirmation
      // of one container still answers.
      const sweep = args.some((value) =>
        value.startsWith('label=wmh.install='),
      );
      if (sweep && this.sweepGate) await this.sweepGate();
      if (sweep && this.emptyListings > 0) {
        this.emptyListings -= 1;
        return '';
      }
      const filters = args.filter(
        (value) => value.startsWith('label=') || value.startsWith('id='),
      );
      return [...this.containers.keys()]
        .filter((id) => filters.every((filter) => this.matches(id, filter)))
        .join('\n');
    }
    if (args[0] === 'inspect') {
      const id = args[3] ?? '';
      this.onInspect?.(id);
      const labels = this.containers.get(id);
      if (!labels) throw new Error('no such container');
      return JSON.stringify(labels);
    }
    if (args[0] === 'rm') {
      this.containers.delete(args[2] ?? '');
      return '';
    }
    throw new Error('unsupported command');
  }
}

// A daemon whose commands cost virtual time: the deadline of a round can
// abort a command before it takes effect.
class CostlyDaemon extends FakeDaemon {
  // The cost of one command of the daemon: the test advances the clock of
  // the round with it.
  onCost: ((args: readonly string[]) => void) | undefined;

  override async run(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    // The command costs the virtual time of the test before it runs.
    this.onCost?.(args);
    return super.run(args, signal);
  }
}

const labelMap = (labels: readonly string[]) => {
  const result: Record<string, string> = {};
  for (const label of labels)
    if (label.startsWith('wmh.')) {
      const index = label.indexOf('=');
      result[label.slice(0, index)] = label.slice(index + 1);
    }
  return result;
};

// The labels of a `docker run` argument list.
const labelsOfArguments = (args: readonly string[]) => {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index++)
    if (args[index] === '--label' && typeof args[index + 1] === 'string') {
      const value = args[index + 1] as string;
      const separator = value.indexOf('=');
      result[value.slice(0, separator)] = value.slice(separator + 1);
    }
  return result;
};

// A process runner that behaves like the Windows runner of the hub: one
// session at a time, and a refusal when the limit is reached. Every peer
// that owns its own runner may run at the same time.
class FakeRunner implements ProcessRunner {
  active = 0;
  runs = 0;

  constructor(private readonly onRun?: (request: ProcessRequest) => void) {}

  async run(request: ProcessRequest) {
    if (this.active >= 1)
      throw new Error(
        'The bounded process concurrency limit has been reached.',
      );
    this.active += 1;
    this.runs += 1;
    try {
      this.onRun?.(request);
      await new Promise<void>((resolve) => {
        request.stream?.started(() => undefined);
        request.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        outcome: 'cancelled' as const,
      };
    } finally {
      this.active -= 1;
    }
  }
}

// The connector of a Docker peer: the shape the transport and the bridge use.
const dockerConnector = (
  id: string,
  overrides: Partial<Extract<Connector, { executionMode: 'docker' }>> = {},
): Extract<Connector, { executionMode: 'docker' }> =>
  ({
    id,
    name: `Container ${id}`,
    description: 'A synthetic Docker connector.',
    enabled: true,
    revision: 1,
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    executionMode: 'docker',
    transport: 'stdio',
    image: 'synthetic-image:1.2.3',
    arguments: [],
    ...overrides,
  }) as Extract<Connector, { executionMode: 'docker' }>;

const markerBody = (values: {
  nonce: string;
  agentId: string;
  bridgeId: string;
  daemonId?: string;
  phase?: string;
  containerId?: string;
  connectorId?: string;
}) => ({
  nonce: values.nonce,
  connectorId: values.connectorId ?? 'connector-0',
  agentId: values.agentId,
  bridgeId: values.bridgeId,
  dockerEndpoint: 'npipe:////./pipe/docker_engine',
  daemonId: values.daemonId ?? 'DAEMON-A',
  phase: values.phase ?? 'running',
  ...(values.containerId ? { containerId: values.containerId } : {}),
});

const directories: string[] = [];
const children: ChildProcess[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'wmh-docker-'));
  directories.push(directory);
  return directory;
}

async function writeMarkerFile(
  directory: string,
  agentId: string,
  bridgeId: string,
  nonce: string,
  body: unknown,
) {
  const folder = join(directory, 'owned-agent-containers', agentId, bridgeId);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${nonce}.json`);
  await writeFile(path, JSON.stringify(body));
  return path;
}

// Whether a path exists: a missing path and an unreadable one are both
// absent for the assertions of this file.
const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function readMarkerFile(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function markerFiles(directory: string, agentId: string) {
  const agentRoot = join(directory, 'owned-agent-containers', agentId);
  const bridges = await readdir(agentRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const found: string[] = [];
  for (const bridge of bridges) {
    if (!bridge.isDirectory()) continue;
    const files = await readdir(join(agentRoot, bridge.name)).catch(() => []);
    for (const file of files)
      if (file.endsWith('.json'))
        found.push(join(agentRoot, bridge.name, file));
  }
  return found.sort();
}

// The disposable folders and the child processes of this file.
afterAll(async () => {
  for (const child of children) child.kill();
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
});

// A real pipe owner in a child process: it holds the pipe and never answers,
// so its instances stay busy.
async function spawnPipeOwner(name: string) {
  const script = `
    const { createServer } = require('node:net');
    const server = createServer((socket) => socket.destroy());
    server.listen(process.argv[1], () => {
      process.stdout.write('listening\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
    });
  `;
  const child = spawn(process.execPath, ['-e', script, name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`the pipe owner exited early: ${code}`)),
    );
  });
  return child;
}

// A real pipe owner in a child process: it holds every pipe it is given and
// never answers, so the probes of those owners never decide.
async function spawnPipeOwners(names: readonly string[]) {
  const script = `
    const { createServer } = require('node:net');
    let pending = process.argv.length - 1;
    for (const name of process.argv.slice(1)) {
      const server = createServer((socket) => socket.destroy());
      server.listen(name, () => {
        pending -= 1;
        if (pending === 0) {
          process.stdout.write('listening\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
        }
      });
    }
  `;
  const child = spawn(process.execPath, ['-e', script, ...names], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`the pipe owner exited early: ${code}`)),
    );
  });
  return child;
}

// Polls an observable condition until it holds: the tests wait for what they
// observe, never for a guessed duration.
async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline)
      throw new Error('The condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  directory: string;
  daemon: FakeDaemon;
  ownership: DockerOwnership;
  agentId: string;
  bridgeId: string;
  installId: string;
  clock: FakeClock;
}

async function createHarness(
  options: {
    agentId?: string;
    bridgeId?: string;
    directory?: string;
    daemon?: FakeDaemon;
    installId?: string;
    // The real timers of the poll of the container id file.
    realTimers?: boolean;
    // The pause point of one marker transition.
    pauseTransition?: (
      nonce: string,
      phase: 'launching' | 'running' | 'removing',
    ) => Promise<void>;
  } = {},
): Promise<Harness> {
  const directory = options.directory ?? (await temporaryDirectory());
  const daemon = options.daemon ?? new FakeDaemon();
  const agentId = options.agentId ?? 'opencode';
  const bridgeId = options.bridgeId ?? randomUUID();
  const installId = options.installId ?? randomUUID();
  const clock = new FakeClock();
  const ownership = createDockerOwnership({
    docker: daemon,
    directory,
    agentId,
    bridgeId,
    installId,
    now: options.realTimers ? () => Date.now() : clock.now,
    setTimer: options.realTimers
      ? (callback, ms) => setTimeout(callback, ms)
      : clock.setTimer,
    clearTimer: options.realTimers
      ? (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      : clock.clearTimer,
    ...(options.pauseTransition
      ? { pauseTransition: options.pauseTransition }
      : {}),
  });
  return { directory, daemon, ownership, agentId, bridgeId, installId, clock };
}

// A timer of the given delay is armed on the virtual clock.
function timerArmed(clock: FakeClock, delay: number): boolean {
  return [...clock.timers.values()].some((timer) => timer.delay === delay);
}

// The recovery round is complete when the container is gone and its marker
// is deleted: the tests wait for both, never for a guessed duration.
async function waitForRecovery(
  daemon: FakeDaemon,
  directory: string,
  agentId: string,
): Promise<void> {
  await until(async () => {
    if (daemon.containers.size !== 0) return false;
    return (await markerFiles(directory, agentId)).length === 0;
  });
}

// The round waits for the probes of its owners: the virtual clock runs the
// timeouts of those probes while the round works.
async function advanceUntilSettled(
  clock: FakeClock,
  round: Promise<void>,
): Promise<void> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  void round.then(mark, mark);
  for (let index = 0; index < 200 && !settled; index++) {
    // The round registers its next timer before the clock moves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (settled) break;
    clock.advance(2_000);
  }
  await round;
}

// The round waits for the probes of its owners: the virtual clock runs the
// timeouts of those probes while the round works. The clock only moves
// while the round waits for a probe, so the preparation of the round
// spends no virtual time and the deadline of the round lands exactly on
// the moment the test needs.
async function advanceUntilProbed(
  clock: FakeClock,
  round: Promise<void>,
): Promise<void> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  void round.then(mark, mark);
  for (let index = 0; index < 400 && !settled; index++) {
    // The round registers its next timer before the clock moves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (settled) break;
    const waiting = [...clock.timers.values()].some(
      (timer) => timer.delay < 10_000,
    );
    if (waiting) clock.advance(2_000);
  }
  await round;
}

// The containers one round inspected: the immutable ids of the inspections
// that the round recorded.
function inspectedIds(daemon: FakeDaemon, from = 0): string[] {
  const ids = new Set<string>();
  for (const call of daemon.calls.slice(from))
    if (call[0] === 'inspect' && typeof call[3] === 'string') ids.add(call[3]);
  return [...ids];
}

// Launches one container session: the CLI writes the immutable id into the
// container id file and the daemon shows the container with its labels.
async function launchContainer(
  harness: Harness,
  options: {
    connectorId?: string;
    image?: string;
    id?: string;
    // The container of a launch that appears late in the daemon.
    visible?: boolean;
  } = {},
) {
  const id = options.id ?? 'a'.repeat(64);
  const launch = await harness.ownership.launch(
    {
      connectorId: options.connectorId ?? 'connector-0',
      image: options.image ?? 'synthetic-image:1.2.3',
      async start(labels, cidfilePath) {
        await mkdir(dirname(cidfilePath), { recursive: true });
        await writeFile(cidfilePath, id);
        if (options.visible !== false) harness.daemon.add(id, labelMap(labels));
      },
    },
    new AbortController().signal,
  );
  await harness.ownership.watch(launch, new AbortController().signal);
  return launch;
}

describe('Docker ownership, recovery and pooling', () => {
  it('pipeName rejects a non-UUID installation, a non-UUID bridge id and an unknown agent id', () => {
    const installId = randomUUID();
    const bridgeId = randomUUID();
    expect(pipeName('bridge', installId, bridgeId)).toBe(
      `\\\\.\\pipe\\wmh-${installId}-bridge-${bridgeId}`,
    );
    expect(pipeName('recovery', installId, 'opencode')).toBe(
      `\\\\.\\pipe\\wmh-${installId}-recovery-opencode`,
    );
    expect(() => pipeName('bridge', 'not-a-uuid', bridgeId)).toThrow();
    expect(() =>
      pipeName('bridge', installId.toUpperCase(), bridgeId),
    ).toThrow();
    expect(() => pipeName('bridge', installId, 'not-a-uuid')).toThrow();
    expect(() => pipeName('bridge', installId, 'opencode')).toThrow();
    expect(() => pipeName('recovery', installId, 'not-an-agent')).toThrow();
    expect(() => pipeName('recovery', installId, bridgeId)).toThrow();
  });

  it('runs two Docker connectors of one bridge with two markers and two containers', async () => {
    const harness = await createHarness();
    const first = await launchContainer(harness, {
      connectorId: 'connector-0',
    });
    const second = await launchContainer(harness, {
      connectorId: 'connector-1',
      id: 'b'.repeat(64),
    });
    expect(first.nonce).not.toBe(second.nonce);
    expect(await markerFiles(harness.directory, 'opencode')).toEqual(
      [first.markerPath, second.markerPath].sort(),
    );
    const body = await readMarkerFile(first.markerPath);
    expect(body).toMatchObject({
      nonce: first.nonce,
      connectorId: 'connector-0',
      agentId: 'opencode',
      bridgeId: harness.bridgeId,
      dockerEndpoint: 'npipe:////./pipe/docker_engine',
      daemonId: 'DAEMON-A',
      phase: 'running',
      containerId: 'a'.repeat(64),
    });
    expect(harness.daemon.containers.size).toBe(2);
    await harness.ownership.close();
  });

  it('keeps the containers of another agent out of the recovery of this agent', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const first = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await launchContainer(first);
    const second = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'codex',
    });
    await second.ownership.recover();
    expect(daemon.containers.size).toBe(1);
    expect(await markerFiles(directory, 'opencode')).toHaveLength(1);
    expect(await markerFiles(directory, 'codex')).toHaveLength(0);
    await first.ownership.close();
    await second.ownership.close();
  });

  it('never reaps the container of a live sibling bridge of the same agent', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const sibling = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const listener = await listenBridge(installId, sibling.bridgeId);
    await launchContainer(sibling);
    const other = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await other.ownership.recover();
    expect(daemon.containers.size).toBe(1);
    expect(await markerFiles(directory, 'opencode')).toHaveLength(1);
    await listener.close();
    await sibling.ownership.close();
    await other.ownership.close();
  });

  it('never reaps the container of a live sibling after a long pause', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const sibling = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const listener = await listenBridge(installId, sibling.bridgeId);
    await launchContainer(sibling);
    const other = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await other.ownership.recover();
    // A long pause passes: the sibling is still live.
    other.clock.advance(3_600_000);
    await other.ownership.recover();
    expect(daemon.containers.size).toBe(1);
    await listener.close();
    await sibling.ownership.close();
    await other.ownership.close();
  });

  it('lets exactly one of two concurrent recoverers hold the recovery pipe', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const first = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const second = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await Promise.all([first.ownership.recover(), second.ownership.recover()]);
    const sweeps = daemon.calls.filter(
      (call) =>
        call[0] === 'ps' && call.includes(`label=wmh.install=${installId}`),
    );
    expect(sweeps).toHaveLength(1);
    await first.ownership.close();
    await second.ownership.close();
  });

  it('releases the recovery mutex when the recoverer is killed', async () => {
    const installId = randomUUID();
    const owner = await spawnPipeOwner(
      pipeName('recovery', installId, 'opencode'),
    );
    // The mutex is held by the child process.
    expect(await acquireRecovery(installId, 'opencode')).toBeUndefined();
    owner.kill();
    await new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    const lock = await acquireRecovery(installId, 'opencode');
    expect(lock).toBeDefined();
    await lock?.close();
  });

  it('removes the orphan of a crashed bridge with the next bridge', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const crashed = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await launchContainer(crashed);
    // The bridge crashed: its pipe is gone.
    const replacement = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await replacement.ownership.recover();
    expect(daemon.containers.size).toBe(0);
    expect(await markerFiles(directory, 'opencode')).toHaveLength(0);
    // The replacement bridge admits one peer of its own.
    await expect(replacement.ownership.admit()).resolves.toBeUndefined();
    await launchContainer(replacement, { id: '8'.repeat(64) });
    expect(daemon.containers.size).toBe(1);
    await crashed.ownership.close();
    await replacement.ownership.close();
  });

  it('keeps the marker of a changed daemon as uncertain cleanup', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const crashed = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await launchContainer(crashed);
    // The daemon changed: the marker belongs to another daemon.
    daemon.daemon = 'DAEMON-B';
    const replacement = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await replacement.ownership.recover();
    expect(daemon.containers.size).toBe(1);
    expect(await markerFiles(directory, 'opencode')).toHaveLength(1);
    await expect(replacement.ownership.admit()).rejects.toBeDefined();
    await crashed.ownership.close();
    await replacement.ownership.close();
  });

  it('refuses Docker while a legacy marker exists and never touches it', async () => {
    const harness = await createHarness();
    const legacy = join(
      harness.directory,
      'owned-agent-containers',
      `wmh-${randomUUID()}.json`,
    );
    await mkdir(dirname(legacy), { recursive: true });
    // The content written here is kept: the legacy marker must read back
    // byte for byte after the admission and its recovery round.
    const original = JSON.stringify({ nonce: randomUUID() });
    await writeFile(legacy, original);
    await expect(harness.ownership.admit()).rejects.toBeDefined();
    expect(await readFile(legacy, 'utf8')).toBe(original);
    expect(harness.daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    await harness.ownership.close();
  });

  it('keeps an uncertain marker of a failed removal and blocks this agent only', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const crashed = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await launchContainer(crashed);
    daemon.fail((args) => args[0] === 'rm', 10);
    const replacement = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await replacement.ownership.recover();
    expect(daemon.containers.size).toBe(1);
    const [markerPath] = await markerFiles(directory, 'opencode');
    const body = await readMarkerFile(markerPath!);
    expect(body['phase']).toBe('removing');
    await expect(replacement.ownership.admit()).rejects.toBeDefined();
    // Another agent is not blocked by the uncertain marker.
    const other = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'codex',
    });
    await expect(other.ownership.admit()).resolves.toBeUndefined();
    await crashed.ownership.close();
    await replacement.ownership.close();
    await other.ownership.close();
  });

  it('does not reap a live owner whose pipe instances are all busy', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const owner = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const other = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const paused = await spawnPipeOwner(
      pipeName('bridge', installId, owner.bridgeId),
    );
    try {
      await launchContainer(owner);
      expect(await probeBridge(installId, owner.bridgeId)).toBe('unknown');
      // The probe of the busy owner runs on the virtual clock of the round.
      await advanceUntilSettled(other.clock, other.ownership.recover());
      expect(daemon.containers.size).toBe(1);
      expect(await markerFiles(directory, 'opencode')).toHaveLength(1);
    } finally {
      paused.kill();
      await owner.ownership.close();
      await other.ownership.close();
    }
  });

  it('shares one recovery mutex between bridges that opened the data folder through differently cased paths', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const other = directory.toUpperCase();
    const first = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const second = await createHarness({
      directory: other,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const lock = await acquireRecovery(installId, 'opencode');
    expect(lock).toBeDefined();
    await Promise.all([first.ownership.recover(), second.ownership.recover()]);
    const sweeps = daemon.calls.filter(
      (call) =>
        call[0] === 'ps' && call.includes(`label=wmh.install=${installId}`),
    );
    expect(sweeps).toHaveLength(0);
    await lock?.close();
    await first.ownership.close();
    await second.ownership.close();
  });

  it('removes a container that appears after two empty listings with the next label sweep', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const crashed = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    // The container of the launch appears late in the daemon.
    const launch = await launchContainer(crashed, { visible: false });
    daemon.emptyListings = 2;
    const replacement = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await replacement.ownership.recover();
    expect(daemon.containers.size).toBe(0);
    await replacement.ownership.recover();
    expect(daemon.containers.size).toBe(0);
    // The container appears after the two empty listings.
    daemon.add('c'.repeat(64), {
      'wmh.install': installId,
      'wmh.agent': 'opencode',
      'wmh.bridge': crashed.bridgeId,
      'wmh.client': launch.nonce,
      'wmh.connector': 'connector-0',
    });
    await replacement.ownership.recover();
    expect(daemon.containers.size).toBe(0);
    expect(await markerFiles(directory, 'opencode')).toHaveLength(0);
    await crashed.ownership.close();
    await replacement.ownership.close();
  });

  it('keeps a launching marker over empty sweeps and bridge restarts and removes its late container with the 60 second sweep', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const first = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    // The CLI never acknowledged the launch: the marker stays `launching`.
    const nonce = randomUUID();
    await writeMarkerFile(
      directory,
      'opencode',
      first.bridgeId,
      nonce,
      markerBody({
        nonce,
        agentId: 'opencode',
        bridgeId: first.bridgeId,
        phase: 'launching',
      }),
    );
    await first.ownership.recover();
    expect(await markerFiles(directory, 'opencode')).toHaveLength(1);
    const second = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await second.ownership.recover();
    expect(await markerFiles(directory, 'opencode')).toHaveLength(1);
    // The container of the late launch appears.
    daemon.add('c'.repeat(64), {
      'wmh.install': installId,
      'wmh.agent': 'opencode',
      'wmh.bridge': first.bridgeId,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    second.clock.advance(60_000);
    await waitForRecovery(daemon, directory, 'opencode');
    expect(daemon.containers.size).toBe(0);
    expect(await markerFiles(directory, 'opencode')).toHaveLength(0);
    await first.ownership.close();
    await second.ownership.close();
  });

  it('keeps the marker of a CLI that timed out during creation and removes its late container', async () => {
    const harness = await createHarness();
    const session: DockerSession = {
      executable: 'C:\\Synthetic\\docker.exe',
      command: harness.daemon as unknown as DockerSession['command'],
      now: harness.clock.now,
      async createRunner() {
        // The CLI of the container fails before the container id file is
        // acknowledged.
        return new FakeRunner(() => {
          throw new Error('synthetic creation timeout');
        });
      },
    };
    // The production launch path: the marker is written before the CLI
    // starts.
    const peer = await dockerAgentTransport(
      dockerConnector('connector-0'),
      new AbortController().signal,
      session,
      harness.ownership,
    );
    await expect(peer.transport.start()).rejects.toBeDefined();
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(1);
    const [markerPath] = await markerFiles(harness.directory, 'opencode');
    const body = await readMarkerFile(markerPath!);
    expect(body['phase']).toBe('launching');
    // The abandoned launch keeps the 60 second recovery alive: the
    // disposal hands it to the recovery, no admission and no restart are
    // needed.
    // The poll of the container id file ends first: the acknowledgement
    // of the abandoned launch never joins.
    harness.clock.advance(60_000);
    await peer.dispose();
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    // The container of the timed out creation appears late.
    harness.daemon.add('d'.repeat(64), {
      'wmh.install': harness.installId,
      'wmh.agent': 'opencode',
      'wmh.bridge': harness.bridgeId,
      'wmh.client': String(body['nonce']),
      'wmh.connector': 'connector-0',
    });
    harness.clock.advance(60_000);
    await waitForRecovery(harness.daemon, harness.directory, 'opencode');
    expect(harness.daemon.containers.size).toBe(0);
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(0);
    await harness.ownership.close();
  });

  it('fails a missing image in the pre-flight and leaves no marker', async () => {
    const harness = await createHarness();
    harness.daemon.fail((args) => args[0] === 'pull', 1);
    await expect(
      harness.ownership.launch(
        {
          connectorId: 'connector-0',
          image: 'missing-image:1',
          async start() {
            throw new Error('the launch must not start');
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(0);
    expect(harness.daemon.calls.some((call) => call[0] === 'pull')).toBe(true);
    await harness.ownership.close();
  });

  it('never cleans a valid stale marker while the inventory of the agent is uncertain', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    // A valid running marker of an absent bridge names its container.
    const absent = randomUUID();
    const nonce = randomUUID();
    const containerId = 'd'.repeat(64);
    const markerPath = await writeMarkerFile(
      directory,
      agentId,
      absent,
      nonce,
      markerBody({
        nonce,
        agentId,
        bridgeId: absent,
        phase: 'running',
        containerId,
      }),
    );
    daemon.add(containerId, {
      'wmh.install': installId,
      'wmh.agent': agentId,
      'wmh.bridge': absent,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    // An unsafe entry beside it makes the inventory of the agent uncertain.
    await writeFile(
      join(directory, 'owned-agent-containers', agentId, 'stray.txt'),
      '',
    );
    const harness = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    await harness.ownership.recover();
    // Nothing is cleaned: the container, its marker and its phase stay.
    expect(daemon.containers.size).toBe(1);
    expect(daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    expect(await markerFiles(directory, agentId)).toEqual([markerPath]);
    expect((await readMarkerFile(markerPath))['phase']).toBe('running');
    await harness.ownership.close();
  });

  it('removes the container id file of a session after a clean disposal', async () => {
    const harness = await createHarness();
    const launch = await launchContainer(harness);
    expect(await pathExists(launch.cidfilePath)).toBe(true);
    await harness.ownership.dispose(launch, new AbortController().signal);
    expect(harness.daemon.containers.size).toBe(0);
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(0);
    expect(await pathExists(launch.cidfilePath)).toBe(false);
    // The folders of the live bridge stay for its next launch.
    expect(await pathExists(dirname(launch.cidfilePath))).toBe(true);
    await harness.ownership.close();
  });

  it('owes the recovery a container id file that a clean disposal could not remove', async () => {
    const harness = await createHarness();
    const launch = await launchContainer(harness);
    unlinkGuard.path = launch.cidfilePath;
    try {
      await harness.ownership.dispose(launch, new AbortController().signal);
      expect(await pathExists(launch.cidfilePath)).toBe(true);
      expect(timerArmed(harness.clock, 60_000)).toBe(true);
    } finally {
      unlinkGuard.path = undefined;
    }
    // The scheduled round removes the file and owes nothing more.
    harness.clock.advance(60_000);
    await harness.ownership.settled();
    expect(await pathExists(launch.cidfilePath)).toBe(false);
    expect(timerArmed(harness.clock, 60_000)).toBe(false);
    await harness.ownership.close();
  });

  it('keeps the recovery armed while the purge cannot remove a file', async () => {
    const harness = await createHarness();
    const cidFolder = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
      randomUUID(),
      'cid',
    );
    const file = join(cidFolder, `${randomUUID()}.cid`);
    await mkdir(cidFolder, { recursive: true });
    await writeFile(file, 'a'.repeat(64));
    unlinkGuard.path = file;
    try {
      await harness.ownership.recover();
      // The pass reached its end, but it left the file behind.
      expect(await pathExists(file)).toBe(true);
      expect(timerArmed(harness.clock, 60_000)).toBe(true);
    } finally {
      unlinkGuard.path = undefined;
    }
    harness.clock.advance(60_000);
    await harness.ownership.settled();
    expect(await pathExists(dirname(cidFolder))).toBe(false);
    expect(timerArmed(harness.clock, 60_000)).toBe(false);
    await harness.ownership.close();
  });

  it('purges the artifacts of a dead bridge and keeps the file of a marker that remains', async () => {
    const harness = await createHarness();
    const agentRoot = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
    );
    // A dead bridge left the container id file of a finished session.
    const finished = randomUUID();
    const finishedNonce = randomUUID();
    await mkdir(join(agentRoot, finished, 'cid'), { recursive: true });
    await writeFile(
      join(agentRoot, finished, 'cid', `${finishedNonce}.cid`),
      'a'.repeat(64),
    );
    // Another dead bridge left an unacknowledged launch: its marker stays,
    // so the container id file of that session stays as well.
    const pending = randomUUID();
    const pendingNonce = randomUUID();
    await writeMarkerFile(
      harness.directory,
      harness.agentId,
      pending,
      pendingNonce,
      markerBody({
        nonce: pendingNonce,
        agentId: harness.agentId,
        bridgeId: pending,
        phase: 'launching',
      }),
    );
    const pendingFile = join(agentRoot, pending, 'cid', `${pendingNonce}.cid`);
    await mkdir(dirname(pendingFile), { recursive: true });
    await writeFile(pendingFile, '');
    await harness.ownership.recover();
    // The finished bridge left nothing behind: its file and its empty
    // folders are gone.
    expect(await pathExists(join(agentRoot, finished))).toBe(false);
    expect(await pathExists(pendingFile)).toBe(true);
    expect(await markerFiles(harness.directory, harness.agentId)).toHaveLength(
      1,
    );
    await harness.ownership.close();
  });

  it('never follows a link of a dead bridge while it purges artifacts', async () => {
    const harness = await createHarness();
    const agentRoot = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
    );
    // The container id folder of a dead bridge is a link to a foreign
    // folder that holds a file with the name of a session.
    const outside = await temporaryDirectory();
    const nonce = randomUUID();
    await writeFile(join(outside, `${nonce}.cid`), 'kept');
    const dead = randomUUID();
    await mkdir(join(agentRoot, dead), { recursive: true });
    await symlink(outside, join(agentRoot, dead, 'cid'), 'junction');
    await harness.ownership.recover();
    expect(await readFile(join(outside, `${nonce}.cid`), 'utf8')).toBe('kept');
    expect(await pathExists(join(agentRoot, dead, 'cid'))).toBe(true);
    await harness.ownership.close();
  });

  it('purges at most sixteen dead bridges in one round and schedules the rest', async () => {
    const harness = await createHarness();
    const agentRoot = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
    );
    // Twenty dead bridges each left the container id file of a finished
    // session. No marker and no container exists: only the purge owes work.
    const dead = Array.from({ length: 20 }, () => randomUUID());
    for (const owner of dead) {
      await mkdir(join(agentRoot, owner, 'cid'), { recursive: true });
      await writeFile(
        join(agentRoot, owner, 'cid', `${randomUUID()}.cid`),
        'a'.repeat(64),
      );
    }
    const remaining = async () => {
      let count = 0;
      for (const owner of dead)
        if (await pathExists(join(agentRoot, owner))) count += 1;
      return count;
    };
    // The first round examines one batch: the rest waits for a later round.
    await harness.ownership.recover();
    expect(await remaining()).toBe(4);
    // The unfinished pass keeps the 60 second recovery armed, and that
    // round finishes the pass.
    expect(timerArmed(harness.clock, 60_000)).toBe(true);
    harness.clock.advance(60_000);
    await harness.ownership.settled();
    expect(await remaining()).toBe(0);
    // The finished pass owes nothing more.
    expect(timerArmed(harness.clock, 60_000)).toBe(false);
    await harness.ownership.close();
  });

  it('bounds the files of one folder per round and resumes them in a scheduled round', async () => {
    const harness = await createHarness();
    const cidFolder = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
      randomUUID(),
      'cid',
    );
    // One dead bridge left one hundred container id files.
    await mkdir(cidFolder, { recursive: true });
    for (let index = 0; index < 100; index++)
      await writeFile(join(cidFolder, `${randomUUID()}.cid`), 'a'.repeat(64));
    await harness.ownership.recover();
    // One round examines at most 64 files.
    expect(await readdir(cidFolder)).toHaveLength(36);
    expect(timerArmed(harness.clock, 60_000)).toBe(true);
    harness.clock.advance(60_000);
    await harness.ownership.settled();
    expect(await pathExists(dirname(cidFolder))).toBe(false);
    expect(timerArmed(harness.clock, 60_000)).toBe(false);
    await harness.ownership.close();
  });

  it('stops the purge inside a folder at the deadline of the round', async () => {
    const harness = await createHarness();
    const cidFolder = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
      randomUUID(),
      'cid',
    );
    await mkdir(cidFolder, { recursive: true });
    for (let index = 0; index < 10; index++)
      await writeFile(join(cidFolder, `${randomUUID()}.cid`), 'a'.repeat(64));
    // The deadline of the round expires right after the first deletion.
    unlinkGuard.after = (path) => {
      if (!path.endsWith('.cid')) return;
      unlinkGuard.after = undefined;
      // The deadline timer of the round is the only timer of 30 seconds.
      harness.clock.advance(30_000);
    };
    try {
      await harness.ownership.recover();
    } finally {
      unlinkGuard.after = undefined;
    }
    // Nothing is deleted after the deadline.
    expect(await readdir(cidFolder)).toHaveLength(9);
    // The rest is owed to the next round, which finishes the folder.
    expect(timerArmed(harness.clock, 60_000)).toBe(true);
    harness.clock.advance(60_000);
    await harness.ownership.settled();
    expect(await pathExists(dirname(cidFolder))).toBe(false);
    await harness.ownership.close();
  });

  it('checks a file again when the deadline ends its marker check', async () => {
    const harness = await createHarness();
    const bridgeFolder = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
      randomUUID(),
    );
    const cidFolder = join(bridgeFolder, 'cid');
    await mkdir(cidFolder, { recursive: true });
    for (let index = 0; index < 3; index++)
      await writeFile(join(cidFolder, `${randomUUID()}.cid`), 'a'.repeat(64));
    // The deadline of the round expires during the first marker check.
    lstatGuard.after = (path) => {
      if (!path.startsWith(bridgeFolder) || !path.endsWith('.json')) return;
      lstatGuard.after = undefined;
      harness.clock.advance(30_000);
    };
    try {
      await harness.ownership.recover();
    } finally {
      lstatGuard.after = undefined;
    }
    // The interrupted file was not decided, so nothing is deleted yet.
    expect(await readdir(cidFolder)).toHaveLength(3);
    // The next round checks it again and finishes the folder.
    expect(timerArmed(harness.clock, 60_000)).toBe(true);
    harness.clock.advance(60_000);
    await harness.ownership.settled();
    expect(await pathExists(bridgeFolder)).toBe(false);
    await harness.ownership.close();
  });

  it('resolves a removing marker that a killed recoverer left behind', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const nonce = randomUUID();
    const bridgeId = randomUUID();
    const containerId = 'e'.repeat(64);
    await writeMarkerFile(
      directory,
      'opencode',
      bridgeId,
      nonce,
      markerBody({
        nonce,
        agentId: 'opencode',
        bridgeId,
        phase: 'removing',
        containerId,
      }),
    );
    const harness = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    await harness.ownership.recover();
    // The container is gone: the marker is deleted.
    expect(await markerFiles(directory, 'opencode')).toHaveLength(0);
    await harness.ownership.close();
  });

  it('retries a failed removal of this bridge own abandoned container with the 60 second recovery', async () => {
    const harness = await createHarness();
    // The production path: the peer is launched and acknowledged.
    const launch = await launchContainer(harness);
    // The removal fails: the marker stays `removing`.
    harness.daemon.fail((args) => args[0] === 'rm', 1);
    await expect(
      harness.ownership.dispose(launch, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(harness.daemon.containers.size).toBe(1);
    const [markerPath] = await markerFiles(harness.directory, 'opencode');
    expect((await readMarkerFile(markerPath!))['phase']).toBe('removing');
    // The next recovery removes it: no new admission and no restart.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    harness.clock.advance(60_000);
    await waitForRecovery(harness.daemon, harness.directory, 'opencode');
    expect(harness.daemon.containers.size).toBe(0);
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(0);
    await harness.ownership.close();
  });

  it('retries a failed absence confirmation of this bridge own abandoned container with the 60 second recovery', async () => {
    const harness = await createHarness();
    // The production path: the peer is launched and acknowledged.
    const launch = await launchContainer(harness);
    // The removal succeeds but the absence confirmation reports the container.
    harness.daemon.fail(
      (args) =>
        args[0] === 'ps' && args.some((value) => value.startsWith('id=')),
      1,
    );
    await expect(
      harness.ownership.dispose(launch, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(1);
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    harness.clock.advance(60_000);
    await waitForRecovery(harness.daemon, harness.directory, 'opencode');
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(0);
    await harness.ownership.close();
  });

  it('removes this bridge own abandoned container and never the container of another live bridge', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const sibling = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    const listener = await listenBridge(installId, sibling.bridgeId);
    await launchContainer(sibling);
    const other = await createHarness({
      directory,
      daemon,
      installId,
      agentId: 'opencode',
    });
    // The abandoned container of this bridge: its nonce belongs to no live
    // entry.
    const nonce = randomUUID();
    await writeMarkerFile(
      directory,
      'opencode',
      other.bridgeId,
      nonce,
      markerBody({
        nonce,
        agentId: 'opencode',
        bridgeId: other.bridgeId,
        phase: 'launching',
      }),
    );
    daemon.add('7'.repeat(64), {
      'wmh.install': installId,
      'wmh.agent': 'opencode',
      'wmh.bridge': other.bridgeId,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    await other.ownership.recover();
    // The container of the live sibling stays, the abandoned one is gone.
    expect(daemon.containers.size).toBe(1);
    expect([...daemon.containers.keys()]).toEqual(['a'.repeat(64)]);
    await listener.close();
    await sibling.ownership.close();
    await other.ownership.close();
  });

  it('blocks the agent with a seventeenth unresolved launching marker', async () => {
    const harness = await createHarness();
    for (let index = 0; index < 16; index++) {
      const nonce = randomUUID();
      await writeMarkerFile(
        harness.directory,
        'opencode',
        harness.bridgeId,
        nonce,
        markerBody({
          nonce,
          agentId: 'opencode',
          bridgeId: harness.bridgeId,
          phase: 'launching',
        }),
      );
    }
    await expect(harness.ownership.admit()).resolves.toBeUndefined();
    const nonce = randomUUID();
    await writeMarkerFile(
      harness.directory,
      'opencode',
      harness.bridgeId,
      nonce,
      markerBody({
        nonce,
        agentId: 'opencode',
        bridgeId: harness.bridgeId,
        phase: 'launching',
      }),
    );
    await expect(harness.ownership.admit()).rejects.toBeDefined();
    await harness.ownership.close();
  });

  it('never removes a container on dispose whose installation, agent or bridge labels differ', async () => {
    for (const foreign of [
      { 'wmh.install': randomUUID() },
      { 'wmh.agent': 'codex' },
      { 'wmh.bridge': randomUUID() },
    ]) {
      const harness = await createHarness();
      const launch = await launchContainer(harness);
      const id = 'a'.repeat(64);
      // The container of the session carries a foreign ownership label.
      harness.daemon.containers.set(id, {
        'wmh.install': harness.installId,
        'wmh.agent': 'opencode',
        'wmh.bridge': harness.bridgeId,
        'wmh.client': launch.nonce,
        'wmh.connector': 'connector-0',
        ...foreign,
      });
      await expect(
        harness.ownership.dispose(launch, new AbortController().signal),
      ).rejects.toBeDefined();
      // The container of another owner survives and the marker is kept.
      expect(harness.daemon.containers.size).toBe(1);
      expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(1);
      expect(harness.daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
      await harness.ownership.close();
    }
  });

  it("authorises the inspected owner, not the marker's bridge", async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    // The owner of the container is alive: its pipe answers.
    const owner = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    const listener = await listenBridge(installId, owner.bridgeId);
    // The marker of an absent bridge names the container of the live one.
    // The marker is valid for its path: the ownership check of the
    // container is reached.
    const nonce = randomUUID();
    const containerId = 'b'.repeat(64);
    const absent = randomUUID();
    await writeMarkerFile(
      directory,
      agentId,
      absent,
      nonce,
      markerBody({
        nonce,
        agentId,
        bridgeId: absent,
        phase: 'running',
        containerId,
      }),
    );
    daemon.add(containerId, {
      'wmh.install': installId,
      'wmh.agent': agentId,
      'wmh.bridge': owner.bridgeId,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    const other = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    await other.ownership.recover();
    // The container of the live owner is never removed.
    expect(daemon.containers.size).toBe(1);
    expect(daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    await listener.close();
    await owner.ownership.close();
    await other.ownership.close();
  });

  it('rejects a marker whose body disagrees with its path', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    const harness = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    // The body of the marker names another bridge than its folder.
    const nonce = randomUUID();
    await writeMarkerFile(
      directory,
      agentId,
      harness.bridgeId,
      nonce,
      markerBody({
        nonce,
        agentId,
        bridgeId: randomUUID(),
        phase: 'running',
        containerId: 'c'.repeat(64),
      }),
    );
    daemon.add('c'.repeat(64), {
      'wmh.install': installId,
      'wmh.agent': agentId,
      'wmh.bridge': harness.bridgeId,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    // The marker is uncertain cleanup: it blocks the agent and it is kept.
    await expect(harness.ownership.admit()).rejects.toBeDefined();
    await harness.ownership.recover();
    // Its container is never removed without a durable record.
    expect(daemon.containers.size).toBe(1);
    expect(await markerFiles(directory, agentId)).toHaveLength(1);
    await harness.ownership.close();
  });

  it('shares one ownership manager between startup recovery and the first admission', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    const bridgeId = randomUUID();
    const clock = new FakeClock();
    let managers = 0;
    // The runtime of the bridge: its initialization is slow, so the startup
    // recovery and the first admission overlap.
    const runtime = createDockerRuntimeOnce(async () => {
      managers += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ownership: createDockerOwnership({
          docker: daemon,
          directory,
          agentId,
          bridgeId,
          installId,
          now: clock.now,
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
        }),
      };
    });
    const first = await runtime();
    // The peer of this bridge is live.
    await first.ownership.launch(
      {
        connectorId: 'connector-0',
        image: 'synthetic-image:1.2.3',
        async start(labels, cidfilePath) {
          await mkdir(dirname(cidfilePath), { recursive: true });
          await writeFile(cidfilePath, 'd'.repeat(64));
          daemon.add('d'.repeat(64), labelMap(labels));
        },
      },
      new AbortController().signal,
    );
    // The startup recovery and the first admission run at once.
    await Promise.all([
      runtime().then((value) => value.ownership.recover()),
      runtime().then((value) => value.ownership.admit()),
    ]);
    expect(managers).toBe(1);
    // The container of the live peer was never reaped.
    expect(daemon.containers.size).toBe(1);
    await first.ownership.close();
  });

  it('keeps a launching marker after empty cleanup listings', async () => {
    const harness = await createHarness();
    // The launch is never acknowledged: the container id file never appears.
    const launch = await harness.ownership.launch(
      {
        connectorId: 'connector-0',
        image: 'synthetic-image:1.2.3',
        async start() {
          /* The CLI of the container was cancelled before it created one. */
        },
      },
      new AbortController().signal,
    );
    await harness.ownership.dispose(launch, new AbortController().signal);
    // The marker survives the empty listings: the container may still be
    // created late.
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(1);
    const body = await readMarkerFile(launch.markerPath);
    expect(body['phase']).toBe('launching');
    // The recovery is scheduled for the late container.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    await harness.ownership.close();
  });

  it('rearms recovery after a failed disposal and after mutex contention', async () => {
    const failed = await createHarness();
    const launch = await launchContainer(failed);
    failed.daemon.fail((args) => args[0] === 'rm', 1);
    await expect(
      failed.ownership.dispose(launch, new AbortController().signal),
    ).rejects.toBeDefined();
    // The abandoned removal keeps its timer.
    expect(
      [...failed.clock.timers.values()].some((timer) => timer.delay === 60_000),
    ).toBe(true);
    await failed.ownership.close();

    const contention = await createHarness();
    // Another recoverer holds the mutex of the agent.
    const lock = await acquireRecovery(contention.installId, 'opencode');
    expect(lock).toBeDefined();
    await contention.ownership.recover();
    // The skipped round is scheduled again.
    expect(
      [...contention.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    await lock?.close();
    await contention.ownership.close();
  });

  it('keeps the marker when the daemon changed before disposal', async () => {
    const harness = await createHarness();
    const launch = await launchContainer(harness);
    // The daemon behind the pinned pipe changed.
    harness.daemon.daemon = 'DAEMON-B';
    await expect(
      harness.ownership.dispose(launch, new AbortController().signal),
    ).rejects.toBeDefined();
    // The container of the other daemon is not removed and its marker is
    // kept.
    expect(harness.daemon.containers.size).toBe(1);
    expect(harness.daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(1);
    await harness.ownership.close();
  });

  it('blocks admission on an unresolved running marker and on running without an id', async () => {
    const unresolved = await createHarness();
    const nonce = randomUUID();
    const containerId = 'e'.repeat(64);
    await writeMarkerFile(
      unresolved.directory,
      'opencode',
      unresolved.bridgeId,
      nonce,
      markerBody({
        nonce,
        agentId: 'opencode',
        bridgeId: unresolved.bridgeId,
        phase: 'running',
        containerId,
      }),
    );
    unresolved.daemon.add(containerId, {
      'wmh.install': unresolved.installId,
      'wmh.agent': 'opencode',
      'wmh.bridge': unresolved.bridgeId,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    // The inspection of the container fails and its absence cannot be
    // confirmed: the marker stays `running`.
    unresolved.daemon.fail((args) => args[0] === 'inspect', 20);
    unresolved.daemon.fail(
      (args) =>
        args[0] === 'ps' && args.some((value) => value.startsWith('id=')),
      20,
    );
    await expect(unresolved.ownership.admit()).rejects.toBeDefined();
    // The marker stays `running`: it is not resolved and it blocks.
    const [markerPath] = await markerFiles(unresolved.directory, 'opencode');
    expect((await readMarkerFile(markerPath!))['phase']).toBe('running');
    await unresolved.ownership.close();

    const withoutId = await createHarness();
    const other = randomUUID();
    await writeMarkerFile(
      withoutId.directory,
      'opencode',
      withoutId.bridgeId,
      other,
      markerBody({
        nonce: other,
        agentId: 'opencode',
        bridgeId: withoutId.bridgeId,
        phase: 'running',
      }),
    );
    // A running marker without the immutable id never resolves.
    await expect(withoutId.ownership.admit()).rejects.toBeDefined();
    await withoutId.ownership.close();
  });

  it('blocks admission on an unreadable inventory and on an unsafe entry', async () => {
    const unreadable = await createHarness();
    // The folder of the agent is not a folder: the inventory is unreadable.
    await rm(join(unreadable.directory, 'owned-agent-containers'), {
      recursive: true,
      force: true,
    });
    await writeFile(
      join(unreadable.directory, 'owned-agent-containers'),
      'not a folder',
    );
    await expect(unreadable.ownership.admit()).rejects.toBeDefined();
    await unreadable.ownership.close();

    const unsafe = await createHarness();
    const folder = join(
      unsafe.directory,
      'owned-agent-containers',
      'opencode',
      unsafe.bridgeId,
    );
    await mkdir(folder, { recursive: true });
    // An unknown entry in the folder of a bridge is not safe to ignore.
    await writeFile(join(folder, 'notes.txt'), 'unexpected');
    await expect(unsafe.ownership.admit()).rejects.toBeDefined();
    // The entry is never deleted.
    expect(await readFile(join(folder, 'notes.txt'), 'utf8')).toBe(
      'unexpected',
    );
    await unsafe.ownership.close();
  });

  it('never rewrites a removing marker back to running', async () => {
    const harness = await createHarness();
    const launch = await harness.ownership.launch(
      {
        connectorId: 'connector-0',
        image: 'synthetic-image:1.2.3',
        async start() {
          /* The container id file appears late. */
        },
      },
      new AbortController().signal,
    );
    const watching = harness.ownership.watch(
      launch,
      new AbortController().signal,
    );
    // The removal of the session started: the marker says `removing`.
    await writeFile(
      launch.markerPath,
      JSON.stringify(
        markerBody({
          nonce: launch.nonce,
          agentId: 'opencode',
          bridgeId: harness.bridgeId,
          phase: 'removing',
          containerId: 'f'.repeat(64),
        }),
      ),
    );
    // The container id file appears after the removal started.
    await mkdir(dirname(launch.cidfilePath), { recursive: true });
    await writeFile(launch.cidfilePath, 'f'.repeat(64));
    harness.clock.advance(1000);
    await watching;
    const body = await readMarkerFile(launch.markerPath);
    expect(body['phase']).toBe('removing');
    await harness.ownership.close();
  });

  it('pools five docker connectors at once', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    const bridgeId = randomUUID();
    const clock = new FakeClock();
    const ownership = createDockerOwnership({
      docker: daemon,
      directory,
      agentId,
      bridgeId,
      installId,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const runners: FakeRunner[] = [];
    const session: DockerSession = {
      executable: 'C:\\Synthetic\\docker.exe',
      command: daemon as unknown as DockerSession['command'],
      async createRunner() {
        const runner = new FakeRunner((request) => {
          // The container of the peer appears with its ownership labels.
          const labels = labelsOfArguments(request.arguments);
          daemon.add(
            String(labels['wmh.client'] ?? '')
              .padEnd(64, '0')
              .slice(0, 64),
            labels,
          );
        });
        runners.push(runner);
        return runner;
      },
    };
    const controller = new AbortController();
    const transports = [];
    for (let index = 0; index < 5; index++)
      transports.push(
        await dockerAgentTransport(
          dockerConnector(`connector-${index}`),
          controller.signal,
          session,
          ownership,
        ),
      );
    // Every peer starts its own container at the same time.
    await Promise.all(transports.map((peer) => peer.transport.start()));
    expect(runners).toHaveLength(5);
    expect(runners.every((runner) => runner.runs === 1)).toBe(true);
    expect(daemon.containers.size).toBe(5);
    controller.abort();
    await ownership.close();
  });

  it('passes the remaining shutdown budget to docker cleanup', async () => {
    // The pool hands the absolute end of the shutdown to the disposal.
    let deadline: number | undefined;
    const pool = createSessionPool<{
      dispose(deadline?: number): Promise<void>;
    }>({
      async start() {
        return { peer: { dispose: async () => undefined } };
      },
      async dispose(_peer, end) {
        deadline = end;
      },
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    await pool.use(
      'connector-0',
      new AbortController().signal,
      5000,
      async () => undefined,
    );
    const before = Date.now();
    await pool.close(5000);
    expect(deadline).toBeDefined();
    expect(deadline!).toBeGreaterThanOrEqual(before + 4000);
    expect(deadline!).toBeLessThanOrEqual(Date.now() + 5000);

    // The Docker cleanup runs on the budget that is left.
    let recorded: AbortSignal | undefined;
    const ownership = {
      bridgeId: randomUUID(),
      installId: randomUUID(),
      admit: async () => undefined,
      launch: async (request: {
        start(labels: readonly string[], cidfilePath: string): Promise<void>;
      }) => {
        await request.start([], 'cid');
        return {
          nonce: randomUUID(),
          connectorId: 'connector-0',
          markerPath: 'marker',
          cidfilePath: 'cid',
        };
      },
      watch: async () => undefined,
      dispose: async (_launch: unknown, signal: AbortSignal) => {
        recorded = signal;
      },
      recover: async () => undefined,
      settled: async () => undefined,
      close: async () => undefined,
    } as unknown as DockerOwnership;
    const session: DockerSession = {
      executable: 'C:\\Synthetic\\docker.exe',
      command: new FakeDaemon() as unknown as DockerSession['command'],
      async createRunner() {
        return new FakeRunner();
      },
    };
    const peer = await dockerAgentTransport(
      dockerConnector('connector-0'),
      new AbortController().signal,
      session,
      ownership,
    );
    await peer.dispose(Date.now() + 1000);
    expect(recorded).toBeDefined();
    expect(recorded!.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // The budget ended with the shutdown deadline, not with a fresh bound.
    expect(recorded!.aborted).toBe(true);
  });

  it('refuses a docker connector with a protected header binding', async () => {
    let launched = false;
    const ownership = {
      bridgeId: randomUUID(),
      installId: randomUUID(),
      admit: async () => undefined,
      launch: async () => {
        launched = true;
        return {
          nonce: randomUUID(),
          connectorId: 'connector-0',
          markerPath: 'marker',
          cidfilePath: 'cid',
        };
      },
      watch: async () => undefined,
      dispose: async () => undefined,
      recover: async () => undefined,
      settled: async () => undefined,
      close: async () => undefined,
    } as unknown as DockerOwnership;
    const session: DockerSession = {
      executable: 'C:\\Synthetic\\docker.exe',
      command: new FakeDaemon() as unknown as DockerSession['command'],
      async createRunner() {
        return new FakeRunner();
      },
    };
    const connector = dockerConnector('connector-0', {
      headerBindings: { Authorization: 'wmh-credential-0' },
    });
    await expect(
      dockerAgentTransport(
        connector,
        new AbortController().signal,
        session,
        ownership,
      ),
    ).rejects.toBeDefined();
    // The container was never launched and no runner was created.
    expect(launched).toBe(false);
  });

  it('recovers an orphan at start after its connector was disabled', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    // The bridge that owned the orphan crashed.
    const crashed = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    await launchContainer(crashed);
    // The next bridge starts: the Docker connector of the agent is
    // disabled, but the agent still owns a marker.
    const next = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    let created = 0;
    await startDockerRecovery({
      directory,
      agentId,
      hasDockerConnector: false,
      runtime: async () => {
        created += 1;
        return next.ownership;
      },
    });
    expect(created).toBe(1);
    expect(daemon.containers.size).toBe(0);
    expect(await markerFiles(directory, agentId)).toHaveLength(0);
    // A bridge whose agent owns no marker and no Docker connector never
    // creates the runtime.
    created = 0;
    await startDockerRecovery({
      directory,
      agentId: 'codex',
      hasDockerConnector: false,
      runtime: async () => {
        created += 1;
        return next.ownership;
      },
    });
    expect(created).toBe(0);
    await crashed.ownership.close();
    await next.ownership.close();
  });

  it('sweeps a markerless orphan at start after its connector was removed', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    const harness = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    // The agent admitted a Docker peer: the durable flag of the agent is
    // written and it is never deleted.
    await harness.ownership.admit();
    // The orphan of a crashed bridge has no marker: only its labels.
    const nonce = randomUUID();
    daemon.add('9'.repeat(64), {
      'wmh.install': installId,
      'wmh.agent': agentId,
      'wmh.bridge': randomUUID(),
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    // The Docker connector of the agent was removed: the next bridge
    // still sweeps the labelled container of the agent.
    let created = 0;
    await startDockerRecovery({
      directory,
      agentId,
      hasDockerConnector: false,
      runtime: async () => {
        created += 1;
        return harness.ownership;
      },
    });
    expect(created).toBe(1);
    expect(daemon.containers.size).toBe(0);
    // The flag of the agent survives the sweep.
    expect(
      await readFile(
        join(directory, 'owned-agent-containers', agentId, 'docker-used'),
        'utf8',
      ),
    ).toBe('');
    await harness.ownership.close();
  });

  it('rearms recovery when the marker cannot be deleted', async () => {
    const harness = await createHarness();
    // The production path: the peer is launched and acknowledged.
    const launch = await launchContainer(harness);
    // The container is gone: the disposal confirms the absence and
    // deletes the marker.
    harness.daemon.containers.clear();
    // The file system refuses the deletion of the marker.
    unlinkGuard.path = launch.markerPath;
    try {
      await expect(
        harness.ownership.dispose(launch, new AbortController().signal),
      ).rejects.toBeDefined();
    } finally {
      unlinkGuard.path = undefined;
    }
    // The marker is still there and the recovery owns it.
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(1);
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    await harness.ownership.close();
  });

  it('removes nothing while a marker entry is a symlink', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    const crashed = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    // The marker of the session is a link: the inventory of the agent
    // cannot be read completely.
    const nonce = randomUUID();
    const containerId = '5'.repeat(64);
    const folder = join(
      directory,
      'owned-agent-containers',
      agentId,
      crashed.bridgeId,
    );
    await mkdir(folder, { recursive: true });
    const target = join(directory, 'link-target');
    await mkdir(target, { recursive: true });
    await symlink(target, join(folder, `${nonce}.json`), 'junction');
    daemon.add(containerId, {
      'wmh.install': installId,
      'wmh.agent': agentId,
      'wmh.bridge': crashed.bridgeId,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    const other = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    await other.ownership.recover();
    // The incomplete inventory is never read as "no marker": the sweep
    // removes nothing and the entry stays.
    expect(daemon.containers.size).toBe(1);
    expect(daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    expect(await markerFiles(directory, agentId)).toHaveLength(1);
    await crashed.ownership.close();
    await other.ownership.close();

    // The disposal of a session whose marker cannot be read removes
    // nothing: the removal is never recorded.
    const harness = await createHarness({
      directory,
      daemon,
      installId,
      agentId,
    });
    const launch = await launchContainer(harness);
    await rm(launch.markerPath, { force: true });
    await symlink(target, launch.markerPath, 'junction');
    const before = daemon.containers.size;
    await expect(
      harness.ownership.dispose(launch, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(daemon.containers.size).toBe(before);
    expect(daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    await harness.ownership.close();
  });

  it('never returns a marker to running when a recovery interleaves with a paused watcher', async () => {
    const daemon = new FakeDaemon();
    const directory = await temporaryDirectory();
    const installId = randomUUID();
    const agentId = 'opencode';
    const bridgeId = randomUUID();
    const clock = new FakeClock();
    // The acknowledgement pauses inside its marker transition: the
    // disposal and the recovery run while it waits.
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const holding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const ownership = createDockerOwnership({
      docker: daemon,
      directory,
      agentId,
      bridgeId,
      installId,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      pauseTransition: async (_nonce, phase) => {
        if (phase !== 'running') return;
        reached();
        await paused;
      },
    });
    // The launch: the container id file appears later.
    const launch = await ownership.launch(
      {
        connectorId: 'connector-0',
        image: 'synthetic-image:1.2.3',
        async start(labels) {
          daemon.add('6'.repeat(64), labelMap(labels));
        },
      },
      new AbortController().signal,
    );
    const watching = ownership.watch(launch, new AbortController().signal);
    // The container id file appears: the acknowledgement starts and
    // pauses inside its transition.
    await mkdir(dirname(launch.cidfilePath), { recursive: true });
    await writeFile(launch.cidfilePath, '6'.repeat(64));
    clock.advance(250);
    await holding;
    // The removal of the container fails: the marker keeps its evidence.
    daemon.fail((args) => args[0] === 'rm', 10);
    // The disposal of the session starts while the acknowledgement waits.
    const controller = new AbortController();
    const disposing = ownership.dispose(launch, controller.signal);
    // The recovery of the agent runs while the acknowledgement waits.
    await ownership.recover();
    // The recovery never takes the session of an acknowledgement that has
    // not joined: the marker stays `launching` and the container stays.
    expect((await readMarkerFile(launch.markerPath))['phase']).toBe(
      'launching',
    );
    expect(daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    // The budget of the disposal ends.
    controller.abort();
    // The acknowledgement is released.
    release();
    await watching;
    await disposing.catch(() => undefined);
    // The marker never returns to `running`.
    expect((await readMarkerFile(launch.markerPath))['phase']).not.toBe(
      'running',
    );
    await ownership.close();
  });

  it('bounds the cleanup of a failed startup with the shutdown deadline', async () => {
    const clock = new FakeClock();
    // The budget of the shutdown: the real session bridge fills it, and the
    // cleanup of a failed startup runs on it.
    const budget: ShutdownBudget = {};
    // The container CLI of the failed startup: it starts, the client sends its
    // initialize request, and the failure waits for the test.
    let started = false;
    let connected = false;
    let release!: () => void;
    const failure = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: ProcessRunner = {
      async run(request: ProcessRequest) {
        started = true;
        request.stream?.started((data: string) => {
          if (data.includes('"initialize"')) connected = true;
        });
        // The startup fails when the test releases it: the abort of the
        // shutdown never ends this run on its own.
        await failure;
        throw new Error('synthetic creation failure');
      },
    };
    let recorded: AbortSignal | undefined;
    let disposed = 0;
    let cleaned = 0;
    const ownership = {
      bridgeId: randomUUID(),
      installId: randomUUID(),
      retainedLaunches: 0,
      admit: async () => undefined,
      launch: async (request: {
        start(labels: readonly string[], cidfilePath: string): Promise<void>;
      }) => {
        // The container runs: the transport exists before the handshake.
        await request.start([], 'cid');
        return {
          nonce: randomUUID(),
          connectorId: 'connector-0',
          markerPath: 'marker',
          cidfilePath: 'cid',
        };
      },
      watch: async () => undefined,
      dispose: async (_launch: unknown, signal: AbortSignal) => {
        recorded = signal;
        disposed = Date.now();
        // The cleanup runs on the budget that is left of the shutdown.
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cleaned = Date.now();
      },
      recover: async () => undefined,
      settled: async () => undefined,
      close: async () => undefined,
    } as unknown as DockerOwnership;
    const session: DockerSession = {
      executable: 'C:\\Synthetic\\docker.exe',
      command: new FakeDaemon() as unknown as DockerSession['command'],
      now: clock.now,
      async createRunner() {
        return runner;
      },
    };
    const state: HubState = profileState(['docker']);
    const connect: BridgeConnect = async (connector, signal, died) =>
      await connectDockerPeer(
        connector as Extract<Connector, { executionMode: 'docker' }>,
        signal,
        died,
        { session, ownership, listener: { close: async () => undefined } },
        budget,
      );
    let seq = 0;
    const bridgeSession: BridgeSession = {
      async snapshot() {
        seq += 1;
        return { seq, state: structuredClone(state), bootId: 'boot-1' };
      },
      async verify() {
        /* A synthetic connector owns no package. */
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    };
    const bridge = createAgentBridge(
      async () => structuredClone(state),
      connect,
      bridgeSession,
      budget,
    );
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await bridge.connect(local);
    const agent = new Client(
      { name: 'synthetic-agent', version: '1' },
      { capabilities: {} },
    );
    await agent.connect(remote);
    // The listing starts the peer: its startup never completes.
    const listing = agent.listTools();
    // The runner started and the client connected to the container.
    await until(() => started);
    await until(() => connected);
    // The shutdown begins: the real session bridge sets the budget.
    const closing = bridge.close();
    await until(() => budget.deadline !== undefined);
    // The startup fails 500 milliseconds before the shutdown ends.
    clock.advance(4500);
    release();
    await listing.catch(() => undefined);
    // The cleanup of the failed startup runs on the budget that is left.
    await until(() => recorded !== undefined);
    expect(recorded!.aborted).toBe(false);
    await until(() => recorded!.aborted, 2000);
    // The cleanup ends with the budget that is left, not on a fresh bound.
    expect(cleaned - disposed).toBeLessThan(2000);
    expect(cleaned).toBeGreaterThan(0);
    await closing;
    await agent.close();
  });

  it('retries docker initialization after a transient failure', async () => {
    const directory = await temporaryDirectory();
    const install = await ensureInstallRecord(directory);
    const agentId = 'opencode';
    const bridgeId = randomUUID();
    let attempts = 0;
    const runtime = createDockerRuntimeOnce(() =>
      createBridgeDockerRuntime({
        directory,
        agentId,
        bridgeId,
        now: () => Date.now(),
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
        async createSession() {
          attempts += 1;
          if (attempts === 1) throw new Error('synthetic discovery failure');
          return {
            executable: 'C:\\Synthetic\\docker.exe',
            command: new FakeDaemon() as unknown as DockerSession['command'],
            async createRunner() {
              return new FakeRunner();
            },
          };
        },
      }),
    );
    // The first attempt fails.
    await expect(runtime()).rejects.toBeDefined();
    // The failed attempt left no listener behind: the pipe of the bridge is
    // free again.
    const listener = await listenBridge(install.installId, bridgeId);
    expect(listener).toBeDefined();
    await listener.close();
    // The next attempt retries and succeeds.
    const second = await runtime();
    expect(attempts).toBe(2);
    expect(second.ownership.bridgeId).toBe(bridgeId);
    await second.listener.close();
    await second.ownership.close();
  });

  it('releases launch state after repeated launches', async () => {
    const harness = await createHarness();
    for (let index = 0; index < 50; index++) {
      const launch = await launchContainer(harness, {
        id: index.toString(16).padStart(64, '0'),
      });
      await harness.ownership.dispose(launch, new AbortController().signal);
      expect(harness.ownership.retainedLaunches).toBe(0);
    }
    expect(harness.ownership.retainedLaunches).toBe(0);
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(0);
    await harness.ownership.close();
  });

  it('refuses removal while the marker cannot be checked', async () => {
    const harness = await createHarness();
    const launch = await launchContainer(harness);
    // The existence of the marker cannot be checked: the file system
    // refuses the inspection of the file.
    lstatGuard.path = launch.markerPath;
    try {
      await expect(
        harness.ownership.dispose(launch, new AbortController().signal),
      ).rejects.toBeDefined();
    } finally {
      lstatGuard.path = undefined;
    }
    // The container stays: a removal that cannot be recorded never runs.
    expect(harness.daemon.containers.size).toBe(1);
    expect(harness.daemon.calls.some((call) => call[0] === 'rm')).toBe(false);
    // The marker stays and the recovery owns it.
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(1);
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    // The failed disposal keeps no launch state behind.
    expect(harness.ownership.retainedLaunches).toBe(0);
    await harness.ownership.close();
  });

  it('keeps a recovery scheduled during a slow sweep', async () => {
    const harness = await createHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    harness.daemon.sweepGate = async () => {
      reached = true;
      await gate;
    };
    // The recovery round starts: the sweep of the labels waits.
    const recovering = harness.ownership.recover();
    await until(() => reached);
    // A launch fails while the round works: the duty it registers must
    // survive the round that did not see it.
    await expect(
      harness.ownership.launch(
        {
          connectorId: 'connector-0',
          image: 'synthetic-image:1.2.3',
          async start() {
            throw new Error('synthetic launch failure');
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    release();
    await recovering;
    // The recovery of the failed launch is still scheduled.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    await harness.ownership.close();
  });

  it('waits for a running round and starts no round after it is closed', async () => {
    const harness = await createHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    harness.daemon.sweepGate = async () => {
      reached = true;
      await gate;
    };
    const recovering = harness.ownership.recover();
    await until(() => reached);
    let settled = false;
    const waiting = harness.ownership.settled().then(() => {
      settled = true;
    });
    await harness.ownership.close();
    // The round still runs: the wait is not over.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await recovering;
    await waiting;
    expect(settled).toBe(true);
    // The closed manager arms no timer and starts no round.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(false);
    const calls = harness.daemon.calls.length;
    await harness.ownership.recover();
    expect(harness.daemon.calls.length).toBe(calls);
    await harness.ownership.settled();
  });

  it('waits for every round of the shutdown within one shared bound', async () => {
    const clock = new FakeClock();
    let finishStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    // The round of the ownership never ends.
    const ownership = new Promise<void>(() => undefined);
    let left = false;
    void settleWithin([startup, ownership], 5_000, clock).then(() => {
      left = true;
    });
    // The startup recovery ends early: the shutdown still waits for the
    // ownership round, and one timer bounds both waits.
    finishStartup();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(left).toBe(false);
    expect(clock.timers.size).toBe(1);
    clock.advance(4_999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(left).toBe(false);
    clock.advance(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(left).toBe(true);
  });

  it('leaves the shutdown wait as soon as every round ended and clears its timer', async () => {
    const clock = new FakeClock();
    let left = false;
    void settleWithin(
      [Promise.resolve(), Promise.reject(new Error('synthetic')), undefined],
      5_000,
      clock,
    ).then(() => {
      left = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(left).toBe(true);
    expect(clock.timers.size).toBe(0);
  });

  it('refuses docker admission when the used flag cannot be written', async () => {
    const harness = await createHarness();
    // The file system refuses the durable flag of the agent.
    openGuard.path = join(
      harness.directory,
      'owned-agent-containers',
      harness.agentId,
      'docker-used',
    );
    try {
      await expect(harness.ownership.admit()).rejects.toMatchObject({
        reason: 'dependency_unavailable',
      });
    } finally {
      openGuard.path = undefined;
    }
    // The agent is refused: a labelled container of this agent could
    // survive without a marker.
    expect(harness.ownership.retainedLaunches).toBe(0);
    await harness.ownership.close();
  });

  it('retries a markerless sweep after a listing failure', async () => {
    const harness = await createHarness();
    // The agent admitted a Docker peer: the durable flag of the agent is
    // written and it is never deleted.
    await harness.ownership.admit();
    // The orphan of a crashed bridge has no marker: only its labels.
    const nonce = randomUUID();
    harness.daemon.add('7'.repeat(64), {
      'wmh.install': harness.installId,
      'wmh.agent': harness.agentId,
      'wmh.bridge': randomUUID(),
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    // The listing of the sweep fails.
    harness.daemon.fail(
      (args) =>
        args[0] === 'ps' &&
        args.some((value) => value.startsWith('label=wmh.install=')),
      1,
    );
    await harness.ownership.recover();
    // The container stays: the sweep could not examine it.
    expect(harness.daemon.containers.size).toBe(1);
    // The incomplete sweep keeps the recovery armed.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    // The next sweep removes the orphan.
    harness.clock.advance(60_000);
    await waitForRecovery(harness.daemon, harness.directory, harness.agentId);
    expect(harness.daemon.containers.size).toBe(0);
    await harness.ownership.close();
  });

  it('retries a markerless sweep after an inspect failure', async () => {
    const harness = await createHarness();
    // The agent admitted a Docker peer: the durable flag of the agent is
    // written and it is never deleted.
    await harness.ownership.admit();
    // The orphan of a crashed bridge has no marker: only its labels.
    const nonce = randomUUID();
    harness.daemon.add('8'.repeat(64), {
      'wmh.install': harness.installId,
      'wmh.agent': harness.agentId,
      'wmh.bridge': randomUUID(),
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    // The inspection of the container fails.
    harness.daemon.fail((args) => args[0] === 'inspect', 1);
    await harness.ownership.recover();
    // The container stays: the sweep could not examine it.
    expect(harness.daemon.containers.size).toBe(1);
    // The incomplete sweep keeps the recovery armed.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    // The next sweep removes the orphan.
    harness.clock.advance(60_000);
    await waitForRecovery(harness.daemon, harness.directory, harness.agentId);
    expect(harness.daemon.containers.size).toBe(0);
    await harness.ownership.close();
  });

  it('removes markerless orphans beyond one batch over successive rounds', async () => {
    const harness = await createHarness();
    // The agent admitted a Docker peer: the durable flag of the agent is
    // written and it is never deleted.
    await harness.ownership.admit();
    // 65 orphans of an absent owner: the listing is longer than one batch.
    const absent = randomUUID();
    for (let index = 0; index < 65; index++)
      harness.daemon.add(index.toString(16).padStart(64, '0'), {
        'wmh.install': harness.installId,
        'wmh.agent': harness.agentId,
        'wmh.bridge': absent,
        'wmh.client': randomUUID(),
        'wmh.connector': 'connector-0',
      });
    // The first round reads one batch of the listing.
    const from = harness.daemon.calls.length;
    await harness.ownership.recover();
    // The round never inspects more than one batch of containers.
    expect(inspectedIds(harness.daemon, from)).toHaveLength(64);
    expect(harness.daemon.containers.size).toBe(1);
    // The incomplete sweep keeps the recovery armed.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(true);
    // The timer round continues where the first one stopped: no admission
    // and no restart are needed.
    harness.clock.advance(60_000);
    await waitForRecovery(harness.daemon, harness.directory, harness.agentId);
    expect(harness.daemon.containers.size).toBe(0);
    await harness.ownership.close();
  });

  it('reaches an orphan behind slow owner probes on a later round', async () => {
    const harness = await createHarness();
    // 16 owners whose pipes never answer: a child process holds them, so
    // every probe of them runs into its timeout.
    const owners = Array.from({ length: 16 }, () => randomUUID());
    const held = await spawnPipeOwners(
      owners.map((owner) => pipeName('bridge', harness.installId, owner)),
    );
    try {
      // The slow containers are listed before the orphan.
      for (const [index, owner] of owners.entries())
        harness.daemon.add(index.toString(16).padStart(64, '0'), {
          'wmh.install': harness.installId,
          'wmh.agent': harness.agentId,
          'wmh.bridge': owner,
          'wmh.client': randomUUID(),
          'wmh.connector': 'connector-0',
        });
      // The eligible orphan of an absent owner is listed behind them.
      const orphan = 'f'.repeat(64);
      harness.daemon.add(orphan, {
        'wmh.install': harness.installId,
        'wmh.agent': harness.agentId,
        'wmh.bridge': randomUUID(),
        'wmh.client': randomUUID(),
        'wmh.connector': 'connector-0',
      });
      // The first round spends its whole deadline on the slow owners.
      await advanceUntilSettled(harness.clock, harness.ownership.recover());
      // The orphan behind them was never examined.
      expect(harness.daemon.containers.has(orphan)).toBe(true);
      // The next round resumes after the last id the first one reached.
      await advanceUntilSettled(harness.clock, harness.ownership.recover());
      // The orphan is gone: the slow owners keep their containers.
      expect(harness.daemon.containers.has(orphan)).toBe(false);
      expect(harness.daemon.containers.size).toBe(16);
    } finally {
      held.kill();
      await harness.ownership.close();
    }
  });

  it('reaches a markerless orphan behind slow markers', async () => {
    const harness = await createHarness();
    // 16 owners whose pipes never answer: a child process holds them, so
    // every probe of them runs into its timeout.
    const owners = Array.from({ length: 16 }, () => randomUUID());
    const held = await spawnPipeOwners(
      owners.map((owner) => pipeName('bridge', harness.installId, owner)),
    );
    try {
      // Every owner names a running marker of an existing container.
      for (const [index, owner] of owners.entries()) {
        const nonce = randomUUID();
        const id = index.toString(16).padStart(64, '0');
        await writeMarkerFile(
          harness.directory,
          harness.agentId,
          owner,
          nonce,
          markerBody({
            nonce,
            agentId: harness.agentId,
            bridgeId: owner,
            containerId: id,
          }),
        );
        harness.daemon.add(id, {
          'wmh.install': harness.installId,
          'wmh.agent': harness.agentId,
          'wmh.bridge': owner,
          'wmh.client': nonce,
          'wmh.connector': 'connector-0',
        });
      }
      // The eligible orphan of an absent owner is listed behind the slow
      // markers.
      const orphan = 'f'.repeat(64);
      harness.daemon.add(orphan, {
        'wmh.install': harness.installId,
        'wmh.agent': harness.agentId,
        'wmh.bridge': randomUUID(),
        'wmh.client': randomUUID(),
        'wmh.connector': 'connector-0',
      });
      // The marker pass probes its sixteen slow owners at the same time, so
      // the sweep reaches the orphan behind them.
      await advanceUntilProbed(harness.clock, harness.ownership.recover());
      await advanceUntilProbed(harness.clock, harness.ownership.recover());
      // The orphan is gone: the slow owners keep their containers and their
      // markers.
      expect(harness.daemon.containers.has(orphan)).toBe(false);
      expect(harness.daemon.containers.size).toBe(16);
      expect(
        await markerFiles(harness.directory, harness.agentId),
      ).toHaveLength(16);
    } finally {
      held.kill();
      await harness.ownership.close();
    }
  });

  it('runs the label sweep on a round the marker pass cannot finish', async () => {
    const harness = await createHarness();
    // One owner whose pipe never answers: a child process holds it, so
    // every probe of it runs into its timeout.
    const owner = randomUUID();
    const held = await spawnPipeOwner(
      pipeName('bridge', harness.installId, owner),
    );
    try {
      // 16 running markers of existing containers. The inspection of every
      // container costs two seconds of virtual time, so the marker pass
      // cannot finish its batch inside the deadline of a round.
      for (let index = 0; index < 16; index++) {
        const nonce = randomUUID();
        const id = (index + 1).toString(16).padStart(64, '0');
        await writeMarkerFile(
          harness.directory,
          harness.agentId,
          owner,
          nonce,
          markerBody({
            nonce,
            agentId: harness.agentId,
            bridgeId: owner,
            containerId: id,
          }),
        );
        harness.daemon.add(id, {
          'wmh.install': harness.installId,
          'wmh.agent': harness.agentId,
          'wmh.bridge': owner,
          'wmh.client': nonce,
          'wmh.connector': 'connector-0',
        });
      }
      // The eligible orphan of an absent owner has the lowest id, so the
      // sweep reaches it before the slow containers.
      const orphan = '0'.repeat(64);
      harness.daemon.add(orphan, {
        'wmh.install': harness.installId,
        'wmh.agent': harness.agentId,
        'wmh.bridge': randomUUID(),
        'wmh.client': randomUUID(),
        'wmh.connector': 'connector-0',
      });
      // The inspection of every container but the orphan costs two seconds
      // of virtual time.
      harness.daemon.onInspect = (id) => {
        if (id !== orphan) harness.clock.advance(2_000);
      };
      // The first round runs the marker pass, which never finishes its
      // batch. The second round runs the label sweep first, so it reaches
      // the orphan.
      await advanceUntilProbed(harness.clock, harness.ownership.recover());
      expect(harness.daemon.containers.has(orphan)).toBe(true);
      await advanceUntilProbed(harness.clock, harness.ownership.recover());
      // The orphan is gone: the slow owner keeps its containers and its
      // markers.
      expect(harness.daemon.containers.has(orphan)).toBe(false);
      expect(harness.daemon.containers.size).toBe(16);
      expect(
        await markerFiles(harness.directory, harness.agentId),
      ).toHaveLength(16);
    } finally {
      held.kill();
      await harness.ownership.close();
    }
  });

  it('retries an item interrupted by the round deadline', async () => {
    const harness = await createHarness();
    // 14 owners whose pipes never answer: a child process holds them, so
    // every probe of them runs into its timeout.
    const owners = Array.from({ length: 14 }, () => randomUUID());
    const held = await spawnPipeOwners(
      owners.map((owner) => pipeName('bridge', harness.installId, owner)),
    );
    try {
      // The slow containers are listed before the orphan.
      for (const [index, owner] of owners.entries())
        harness.daemon.add(index.toString(16).padStart(64, '0'), {
          'wmh.install': harness.installId,
          'wmh.agent': harness.agentId,
          'wmh.bridge': owner,
          'wmh.client': randomUUID(),
          'wmh.connector': 'connector-0',
        });
      // The eligible orphan of an absent owner is listed behind them.
      const orphan = 'f'.repeat(64);
      harness.daemon.add(orphan, {
        'wmh.install': harness.installId,
        'wmh.agent': harness.agentId,
        'wmh.bridge': randomUUID(),
        'wmh.client': randomUUID(),
        'wmh.connector': 'connector-0',
      });
      // The inspection of the orphan costs three seconds of virtual time.
      harness.daemon.onInspect = (id) => {
        if (id === orphan) harness.clock.advance(3_000);
      };
      // The first round runs into the deadline while the orphan is
      // inspected: the orphan survives it.
      await advanceUntilProbed(harness.clock, harness.ownership.recover());
      expect(harness.daemon.containers.has(orphan)).toBe(true);
      // The interrupted item is never passed: a later round starts at it
      // again and removes it.
      for (let round = 0; round < 2; round++)
        await advanceUntilProbed(harness.clock, harness.ownership.recover());
      expect(harness.daemon.containers.has(orphan)).toBe(false);
      // The slow owners keep their containers.
      expect(harness.daemon.containers.size).toBe(14);
    } finally {
      held.kill();
      await harness.ownership.close();
    }
  });

  it('moves past an item that the round deadline always interrupts', async () => {
    const daemon = new CostlyDaemon();
    const harness = await createHarness({ daemon });
    // Two markerless orphans of absent owners: the slow one is listed
    // before the fast one.
    const slow = '1'.repeat(64);
    const fast = '2'.repeat(64);
    for (const id of [slow, fast])
      daemon.add(id, {
        'wmh.install': harness.installId,
        'wmh.agent': harness.agentId,
        'wmh.bridge': randomUUID(),
        'wmh.client': randomUUID(),
        'wmh.connector': 'connector-0',
      });
    // Every command of a round costs virtual time: the daemon answers in
    // five seconds, the listing in five seconds, the inspection of the
    // slow container in seven seconds and its removal in seven seconds.
    // The deadline of a round is thirty seconds, so it always cuts the
    // removal of the slow container short and the container survives it.
    daemon.onCost = (args) => {
      if (args[0] === 'info') harness.clock.advance(5_000);
      else if (
        args[0] === 'ps' &&
        args.some((value) => value.startsWith('label=wmh.install='))
      )
        harness.clock.advance(5_000);
      else if (args[0] === 'inspect' && args[3] === slow)
        harness.clock.advance(7_000);
      else if (args[0] === 'rm' && args[2] === slow)
        harness.clock.advance(7_000);
    };
    // The obligation of the agent: it is armed while the recovery owes a
    // cleanup.
    const armed = () =>
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      );
    const inspections = (id: string) =>
      daemon.calls.filter((call) => call[0] === 'inspect' && call[3] === id)
        .length;
    // The first round: the deadline interrupts the removal of the slow
    // container and the cursor is held at it.
    await harness.ownership.recover();
    expect(harness.daemon.containers.has(slow)).toBe(true);
    expect(inspections(slow)).toBe(2);
    expect(armed()).toBe(true);
    // The second round: the same interruption and the same held cursor.
    await harness.ownership.recover();
    expect(harness.daemon.containers.has(slow)).toBe(true);
    expect(inspections(slow)).toBe(4);
    expect(armed()).toBe(true);
    // The third round: the slow container is deferred, so the fast one
    // behind it is examined and removed.
    await harness.ownership.recover();
    expect(harness.daemon.containers.has(fast)).toBe(false);
    expect(harness.daemon.containers.has(slow)).toBe(true);
    // The deferred container was not examined in the deferral round.
    expect(inspections(slow)).toBe(4);
    // The deferred container is still owed: the obligation is armed.
    expect(armed()).toBe(true);
    // The recovery round of the sixty second timer wraps the cursor and
    // examines the deferred container again.
    harness.clock.advance(60_000);
    await until(() => inspections(slow) >= 6);
    expect(harness.daemon.containers.has(slow)).toBe(true);
    await until(() => armed());
    await harness.ownership.close();
  });

  it('schedules no recovery after a clean disposal', async () => {
    const harness = await createHarness();
    // The production path: the peer is launched and acknowledged.
    const launch = await launchContainer(harness);
    await harness.ownership.dispose(launch, new AbortController().signal);
    // The container and its marker are gone.
    expect(harness.daemon.containers.size).toBe(0);
    expect(await markerFiles(harness.directory, 'opencode')).toHaveLength(0);
    // The disposal owes the recovery nothing: no timer is armed.
    expect(
      [...harness.clock.timers.values()].some(
        (timer) => timer.delay === 60_000,
      ),
    ).toBe(false);
    // The finished launch keeps no state behind.
    expect(harness.ownership.retainedLaunches).toBe(0);
    await harness.ownership.close();
  });

  it('retries startup recovery after docker initialization failed', async () => {
    const directory = await temporaryDirectory();
    const install = await ensureInstallRecord(directory);
    const agentId = 'opencode';
    const bridgeId = randomUUID();
    const crashedBridgeId = randomUUID();
    const clock = new FakeClock();
    const daemon = new FakeDaemon();
    // A crashed bridge left a marker and a container behind.
    const nonce = randomUUID();
    const containerId = '4'.repeat(64);
    await writeMarkerFile(
      directory,
      agentId,
      crashedBridgeId,
      nonce,
      markerBody({
        nonce,
        agentId,
        bridgeId: crashedBridgeId,
        containerId,
      }),
    );
    daemon.add(containerId, {
      'wmh.install': install.installId,
      'wmh.agent': agentId,
      'wmh.bridge': crashedBridgeId,
      'wmh.client': nonce,
      'wmh.connector': 'connector-0',
    });
    // The Docker initialization of the bridge fails the first time.
    let attempts = 0;
    const runtime = createDockerRuntimeOnce(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic discovery failure');
      return createBridgeDockerRuntime({
        directory,
        agentId,
        bridgeId,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        async createSession() {
          return {
            executable: 'C:\\Synthetic\\docker.exe',
            command: daemon as unknown as DockerSession['command'],
            async createRunner() {
              return new FakeRunner();
            },
          };
        },
      });
    });
    const startupRecovery = createBridgeStartupRecovery({
      directory,
      agentId,
      hasDockerConnector: async () => false,
      runtime: async () => (await runtime()).ownership,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    // The first attempt fails: the Docker initialization failed.
    await startupRecovery.attempt();
    expect(attempts).toBe(1);
    // The retry is armed a minute later.
    expect(
      [...clock.timers.values()].some((timer) => timer.delay === 60_000),
    ).toBe(true);
    // The retry runs the recovery: the orphan of the crashed bridge goes.
    clock.advance(60_000);
    await waitForRecovery(daemon, directory, agentId);
    expect(attempts).toBe(2);
    expect(await markerFiles(directory, agentId)).toHaveLength(0);
    const started = await runtime();
    await started.listener.close();
    await started.ownership.close();
    // The shutdown cancels a pending retry.
    let stoppedAttempts = 0;
    const stopped = createStartupRecoveryRetry({
      due: async () => true,
      recover: async () => {
        stoppedAttempts += 1;
        throw new Error('synthetic failure');
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await stopped.attempt();
    expect(stopped.pending).toBe(true);
    stopped.stop();
    expect(stopped.pending).toBe(false);
    clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stoppedAttempts).toBe(1);
  });
});
