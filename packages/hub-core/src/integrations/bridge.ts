import { lstat, open } from 'node:fs/promises';
import { constants as fsConstants, watchFile, unwatchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  StateSchema,
  SafetyStateSchema,
  IntegrationAgentIdSchema,
  type Connector,
  type HubState,
} from '@waleed/contracts';
import {
  assertNoLinks,
  assertSafePathText,
} from '../adapters/managed-files.js';
import { windowsSecretStore } from '../adapters/secrets/windows.js';
import { createBindingResolver, type SecretLease } from '../auth/bindings.js';
import {
  safeMcpHttpTransport,
  sessionMcpHttpTransport,
} from '../adapters/mcp/http.js';
import { ContainedStdioTransport } from '../adapters/mcp/stdio.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import { isolatedNativeArguments } from '../adapters/mcp/runtime.js';
import { approved, definitionHash, hashData } from '../runtime/registry.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import { readBootRecord, readInstallRecord } from '../runtime/boot.js';
import {
  createDockerSession,
  dockerAgentTransport,
  type DockerSession,
} from './docker-transport.js';
import {
  agentOwesRecovery,
  createDockerOwnership,
  createDockerRuntimeOnce,
  listenBridge,
  scanAgentMarkers,
  settleWithin,
  startDockerRecovery,
  type BridgeListener,
  type DockerOwnership,
} from './docker-ownership.js';
import { packagesRoot } from '../packages/store.js';
import { verifyPackage } from '../packages/verify.js';
import {
  createSessionPool,
  type OperationLease,
  type PoolLimits,
  type SessionPool,
} from './session-pool.js';

export interface BridgePeer {
  client: Client;
  // Closes the peer. The deadline is the absolute end of the shutdown
  // sequence when one is running: the cleanup of the peer runs on the
  // budget that is left.
  dispose(deadline?: number): Promise<void>;
  assertPublic(value: unknown): void;
  // The earliest expiry of the peer's lease, when it resolved one.
  notAfter?: number;
  // The peer's operation window (session mode only).
  beginOperation?(): void;
  endOperation?(): void;
}

// The three texts an agent ever receives. No diagnostic, argument, result or
// server output ever reaches the agent.
const registryUnavailableText =
  'The managed hub registry is unavailable. Inspect local recovery.';
const refreshToolsText = 'Refresh the hub tool list before using this tool.';
const connectorUnavailableText =
  'The connector is unavailable, changed, disabled, or requires authentication. Inspect the hub and refresh tools.';

// The operation deadlines of the spec: a call may take a minute, a listing
// twenty seconds per connector.
const callTimeout = 60_000;
const listTimeout = 20_000;
// The lease ends thirty seconds before the peer may serve another request.
const leaseMargin = 30_000;
// The shutdown sequence gives the pooled peers five seconds to go away.
const poolCloseDeadline = 5_000;
// The interval of the retry of the startup recovery of the agent.
const RECOVERY_RETRY_INTERVAL_MS = 60_000;
// A hub that restarts again during one operation ends it: the peer is replaced
// a few times at most.
const maxReplacements = 3;

export interface BridgeSnapshot {
  seq: number;
  state: HubState;
  bootId: string;
}

// A snapshot that could not be read. `pending` marks a ledger whose only
// open entry is a mutation that is still prepared: its committed or aborted
// result follows and changes the ledger again.
export interface BridgeSnapshotFailure {
  seq: number;
  failed: true;
  pending?: boolean;
}

// The ledger holds a journaled mutation that is only prepared.
export class LedgerPending extends Error {}

// Every snapshot is refused while the ledger holds an open mutation or one
// that needs review. Only a mutation that is merely prepared is pending; a
// review, like an unreadable ledger, is a plain failure.
export function assertLedgerOpen(ledger: {
  operations: readonly { phase: string }[];
}) {
  if (ledger.operations.some((item) => item.phase === 'needs_review'))
    throw new Error();
  if (ledger.operations.some((item) => item.phase === 'prepared'))
    throw new LedgerPending();
}

export interface BridgeSession {
  // Serialised, numbered reads. `inside` runs synchronously inside the same
  // mutex right after the read (successful or failed), before the next read.
  snapshot(
    inside?: (result: BridgeSnapshot | BridgeSnapshotFailure) => void,
  ): Promise<BridgeSnapshot>;
  // The full, cancellable package verification of a managed connector.
  verify(connector: Connector, signal: AbortSignal): Promise<void>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type BridgeConnect = (
  connector: Connector,
  signal: AbortSignal,
  died?: () => void,
) => Promise<BridgePeer>;

// The shutdown budget of the bridge: the absolute end of the shutdown
// sequence. The pooled peers and the cleanup of a startup that failed
// during the shutdown share it, so no cleanup ever runs on a fresh bound
// while the bridge is leaving.
export interface ShutdownBudget {
  deadline?: number;
}

// The limits of the pool of one bridge. Test-only: the production bridge
// command never passes them, and no environment variable, file or registry
// field can set them. Only the idle limit may be shortened, and only to a
// value the production limit already allows.
export interface AgentBridgeOptions {
  limits?: {
    idleMs?: number;
  };
}

// The idle limit of the pool: five minutes in production, shorter only in a
// test that asks for it.
const minimumIdleMs = 100;
const maximumIdleMs = 3_600_000;
const poolLimits = (
  options?: AgentBridgeOptions,
): Partial<PoolLimits> | undefined => {
  const idleMs = options?.limits?.idleMs;
  if (idleMs === undefined) return undefined;
  if (
    !Number.isInteger(idleMs) ||
    idleMs < minimumIdleMs ||
    idleMs > maximumIdleMs
  )
    throw new Error('The pool limits of the bridge are invalid.');
  return { idleMs };
};

// The Docker runtime of one bridge: the Docker session and the ownership
// manager of its agent.
export interface BridgeDockerRuntime {
  session: DockerSession;
  ownership: DockerOwnership;
  // The liveness listener of the bridge: it exists for the whole life of
  // the bridge.
  listener: BridgeListener;
}

// The remote connector of the session mode.
type RemoteConnector = Extract<Connector, { executionMode: 'remote' }>;

// One pooled peer of the session mode: a native process or a Docker
// container. The death of the transport is observed before the handshake and
// the operation window covers the handshake and every operation of the peer.
async function pooledSessionPeer(
  client: Client,
  transport: ContainedStdioTransport,
  died: (() => void) | undefined,
  cleanup: (deadline?: number) => Promise<void>,
  lease: SecretLease | undefined,
): Promise<BridgePeer> {
  // The window opens before the handshake, so `initialize` counts against the
  // first operation. It stays open until the first operation ends.
  let windowOpen = false;
  const beginOperation = () => {
    if (windowOpen) return;
    transport.beginOperation();
    windowOpen = true;
  };
  const endOperation = () => {
    if (!windowOpen) return;
    transport.endOperation();
    windowOpen = false;
  };
  const sessionTransport: Transport = {
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
    async start() {
      await transport.start();
      beginOperation();
    },
    async send(message) {
      await transport.send(message);
    },
    async close() {
      await transport.close();
    },
  };
  transport.onmessage = (message, extra) =>
    sessionTransport.onmessage?.(message, extra);
  // The death of the transport is observed before the handshake, and only
  // once.
  let dead = false;
  const signalDeath = () => {
    if (dead) return;
    dead = true;
    died?.();
  };
  transport.onerror = (error) => {
    signalDeath();
    sessionTransport.onerror?.(error);
  };
  transport.onclose = () => {
    signalDeath();
    sessionTransport.onclose?.();
  };
  // A protocol error the SDK raises (an unknown response id, a malformed
  // notification) ends the session as a transport error does, from the
  // handshake on.
  client.onerror = () => {
    signalDeath();
  };
  await client.connect(sessionTransport, { timeout: 20000 });
  return {
    client,
    ...(lease?.notAfter === undefined ? {} : { notAfter: lease.notAfter }),
    beginOperation,
    endOperation,
    async dispose(deadline?: number) {
      try {
        await client.close();
      } finally {
        try {
          await cleanup(deadline);
        } finally {
          lease?.dispose();
        }
      }
    },
    assertPublic(value) {
      assertNoCredentialEcho(value, [
        ...Object.values(lease?.environment ?? {}),
        ...Object.values(lease?.headers ?? {}),
      ]);
    },
  };
}

// The pooled remote peer of the session mode: one HTTP session for the whole
// life of the pool entry. The cleanup is idempotent and terminates the remote
// session before the signals of the peer are aborted, so a failed handshake
// never strands the session the peer issued.
export async function remoteSessionPeer(
  client: Client,
  connector: RemoteConnector,
  signal: AbortSignal,
  died: () => void,
  lease: SecretLease | undefined,
  // A local fixture origin is a construction-time testing exception.
  fixtureOrigin?: string,
): Promise<BridgePeer> {
  // The death of the peer is observed once, from the handshake on.
  let dead = false;
  const signalDeath = () => {
    if (dead) return;
    dead = true;
    died();
  };
  const remote = sessionMcpHttpTransport(
    connector.endpoint,
    connector.transport,
    signal,
    signalDeath,
    lease?.headers,
    fixtureOrigin,
  );
  // The window opens before the handshake, so `initialize` counts against
  // the first operation. It stays open until the first operation ends.
  let windowOpen = false;
  const beginOperation = () => {
    if (windowOpen) return;
    remote.beginOperation();
    windowOpen = true;
  };
  const endOperation = () => {
    if (!windowOpen) return;
    remote.endOperation();
    windowOpen = false;
  };
  client.onerror = signalDeath;
  beginOperation();
  try {
    await client.connect(remote.transport, { timeout: 20000 });
  } catch (error) {
    // The remote session is terminated before the local cleanup: the DELETE
    // needs a signal of its own.
    try {
      await remote.dispose();
    } finally {
      await client.close();
    }
    throw error;
  }
  return {
    client,
    ...(lease?.notAfter === undefined ? {} : { notAfter: lease.notAfter }),
    beginOperation,
    endOperation,
    async dispose() {
      try {
        await remote.dispose();
      } finally {
        try {
          await client.close();
        } finally {
          lease?.dispose();
        }
      }
    },
    assertPublic(value) {
      assertNoCredentialEcho(value, [
        ...Object.values(lease?.environment ?? {}),
        ...Object.values(lease?.headers ?? {}),
      ]);
    },
  };
}

// The bridge the agent talks to. It is the SDK server plus the reconciliation
// the watcher triggers.
export interface AgentBridgeServer extends Server {
  reconcile(): Promise<void>;
}

// One pooled native peer: the peer itself and the stamps it was authorised
// with.
interface PooledPeer {
  peer: BridgePeer;
  definitionHash: string;
  credentials: string;
  bootId: string;
}

// The registry could not be read: the bridge fails closed.
class RegistryUnavailable extends Error {
  constructor() {
    super(registryUnavailableText);
  }
}

// A peer may not serve this request any more: it is invalidated.
class PeerRefused extends Error {}

// The agent used a tool of a definition that is no longer current. The peer
// stays; only this request is refused.
class StaleTool extends Error {}

// The peer answered the request with a JSON-RPC error: an ordinary tool
// failure, so the peer keeps serving.
class PeerAnswered extends Error {}

// Every other failure (timeout, closed connection, a result that fails its
// schema, a refused validation) ends the peer.
const peerAnswered = (error: unknown) =>
  error instanceof McpError &&
  error.code !== ErrorCode.RequestTimeout &&
  error.code !== ErrorCode.ConnectionClosed;

// The caller's cancellation or the operation deadline cut the operation
// short. Before dispatch no request reached the server, so the peer stays;
// after dispatch the pool has already ended it. A failure of its own, such
// as a modified package, is never read as an abandonment.
const abandoned = (lease: OperationLease<PooledPeer>, error: unknown) =>
  lease.signal.aborted &&
  error instanceof RuntimeFault &&
  (error.reason === 'cancelled' || error.reason === 'timed_out');

// The credential stamp of a connector: the sorted, de-duplicated ids of its
// secret and header bindings with the reference state that authorised them.
// A missing reference is null; the stamp never carries a secret value.
function credentialStamp(connector: Connector, state: HubState) {
  const ids = [
    ...new Set([
      ...Object.values(connector.secretBindings),
      ...Object.values(connector.headerBindings),
    ]),
  ].sort();
  return JSON.stringify(
    ids.map((id) => {
      const reference = state.secretReferences.find((item) => item.id === id);
      if (!reference) return null;
      return {
        id,
        adapter: reference.adapter,
        present: reference.present,
        kind: reference.kind ?? null,
        owned: reference.ownerIds.includes(connector.id),
      };
    }),
  );
}

// Provider cleanup diagnostics can contain credentials. Recovery evidence stays
// local; a failed peer must never expose a raw SDK/process error to an agent.
async function disposePeer(peer: BridgePeer | undefined, deadline?: number) {
  try {
    await peer?.dispose(deadline);
  } catch {
    /* Scoped Docker markers remain blocking. */
  }
}
export function assertNoCredentialEcho(value: unknown, secrets: string[]) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
  for (const secret of secrets.flatMap((value) => [
    value,
    value.replace(/^(?:Bearer|Basic)\s+/i, ''),
  ])) {
    if (
      secret &&
      [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString('base64'),
      ].some((item) => text.includes(JSON.stringify(item).slice(1, -1)))
    )
      throw new Error();
  }
}
// Agents prefix bridge tools (e.g. `mcp__waleed-mcp-hub__`, 21 chars) and cap
// the full name at 64, so readable names stay within 40 characters.
const toolNameLimit = 40;
const slug = (value: string) =>
  value
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
export function bridgeToolName(
  connector: Pick<Connector, 'id' | 'name'>,
  tool: string,
  taken: ReadonlySet<string>,
) {
  const name = `${slug(connector.name).toLowerCase() || 'connector'}__${slug(tool) || 'tool'}`;
  if (name.length <= toolNameLimit && !taken.has(name)) return name;
  // Too long or colliding: keep the readable prefix and add a stable short hash.
  const suffix = `_${hashData([connector.id, tool]).slice(0, 6)}`;
  return `${name.slice(0, toolNameLimit - suffix.length).replace(/[_-]+$/, '')}${suffix}`;
}

// The session mode of the bridge: one pool of native and remote peers, the
// validation before every dispatch and the reconciliation the watcher
// triggers.
interface SessionBridge {
  // The numbered registry snapshot; it fails closed.
  snapshot(): Promise<BridgeSnapshot>;
  // The pooled listing of one native or remote connector.
  list(
    connector: Connector,
    signal: AbortSignal,
    budget: number,
  ): Promise<Tool[]>;
  // The pooled call of one native or remote connector.
  call(
    connector: Connector,
    expectedHash: string,
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  // Reconciles the pooled peers with the registry.
  reconcile(): Promise<void>;
  // Closes the pool.
  close(): Promise<void>;
}

function createSessionBridge(
  session: BridgeSession,
  connect: BridgeConnect,
  server: Server,
  budget?: ShutdownBudget,
  limits?: Partial<PoolLimits>,
): SessionBridge {
  let closed = false;
  // The peer's own tool list changes reach the agent, at most once a second.
  let changedAt = Number.NEGATIVE_INFINITY;
  let changedTimer: unknown;
  const changed = () => {
    if (closed) return;
    const now = session.now();
    const wait = 1000 - (now - changedAt);
    if (wait <= 0) {
      changedAt = now;
      void server.sendToolListChanged().catch(() => undefined);
      return;
    }
    if (changedTimer === undefined)
      changedTimer = session.setTimer(() => {
        changedTimer = undefined;
        changedAt = session.now();
        void server.sendToolListChanged().catch(() => undefined);
      }, wait);
  };
  const pool: SessionPool<PooledPeer> = createSessionPool<PooledPeer>({
    // The startup authorisation: a fresh stable snapshot decides, before any
    // secret is resolved and any process starts. The peer is started from
    // that snapshot's definition and carries its stamps for its whole life.
    async start(key, lifetime, died) {
      if (closed) throw new PeerRefused();
      const snapshot = await session.snapshot();
      lifetime.throwIfAborted();
      const connector = snapshot.state.connectors.find(
        (item) => item.id === key,
      );
      if (
        !connector ||
        (connector.executionMode !== 'native' &&
          connector.executionMode !== 'remote' &&
          connector.executionMode !== 'docker') ||
        !connector.enabled ||
        !approved(connector)
      )
        throw new PeerRefused();
      // The handshake's window stays open: `initialize` counts against the
      // first operation, which closes it.
      const peer = await connect(connector, lifetime, died);
      peer.client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        () => {
          changed();
        },
      );
      return {
        peer: {
          peer,
          definitionHash: definitionHash(connector),
          credentials: credentialStamp(connector, snapshot.state),
          bootId: snapshot.bootId,
        },
        ...(peer.notAfter === undefined ? {} : { notAfter: peer.notAfter }),
        seq: snapshot.seq,
      };
    },
    async dispose(pooled, deadline) {
      await disposePeer(pooled.peer, deadline);
    },
    now: () => session.now(),
    setTimer: (callback, ms) => session.setTimer(callback, ms),
    clearTimer: (handle) => session.clearTimer(handle),
    ...(limits ? { limits } : {}),
  });

  // The validation before one SDK request. A boot mismatch is not a failure:
  // the peer is replaced and the caller dispatches on the fresh one.
  const readSnapshot = async () => {
    try {
      return await session.snapshot();
    } catch {
      throw new RegistryUnavailable();
    }
  };

  const dispatch = async <T>(
    connector: Connector,
    expectedHash: string,
    lease: OperationLease<PooledPeer>,
    admission: boolean,
    // The deadline of the whole operation: an admitted operation must end
    // before the lease of its peer does.
    deadline: number,
    send: (peer: BridgePeer, signal: AbortSignal) => Promise<T>,
  ): Promise<{ replaced: false; value: T } | { replaced: true }> => {
    try {
      // The agent's tool belongs to the definition it listed; a peer of a
      // newer definition never serves it, even after a replacement. The
      // serving peer's definition is immutable, so a mismatch is decided
      // before anything else, against the registry: a stale caller never
      // touches a healthy peer, and a pooled peer older than the registry
      // never serves again.
      if (lease.peer.definitionHash !== expectedHash) {
        const latest = (await readSnapshot()).state.connectors.find(
          (item) => item.id === connector.id,
        );
        const currentHash = latest ? definitionHash(latest) : undefined;
        if (currentHash !== lease.peer.definitionHash) lease.invalidate();
        if (currentHash !== expectedHash) throw new StaleTool();
        throw new PeerRefused();
      }
      // 1. A reused managed package is verified once per operation.
      if (
        admission &&
        !lease.fresh &&
        connector.executionMode === 'native' &&
        connector.package
      )
        await session.verify(connector, lease.signal);
      // 2. The registry snapshot.
      const snapshot = await readSnapshot();
      const pooled = lease.peer;
      const current = snapshot.state.connectors.find(
        (item) => item.id === connector.id,
      );
      // 3-6. The connector, its definition, its credentials and its lease.
      if (!current || !current.enabled || !approved(current))
        throw new PeerRefused();
      if (definitionHash(current) !== pooled.definitionHash)
        throw new PeerRefused();
      if (credentialStamp(current, snapshot.state) !== pooled.credentials)
        throw new PeerRefused();
      // An admission also needs the lease to outlast the whole operation:
      // the pool ends the peer thirty seconds before the lease does, and a
      // call that is cut there may already have had its effect. A fresh
      // peer would resolve the same stored value and the same expiry, so the
      // peer is refused instead of replaced.
      if (
        pooled.peer.notAfter !== undefined &&
        pooled.peer.notAfter - session.now() <=
          leaseMargin + (admission ? deadline : 0)
      )
        throw new PeerRefused();
      // 7. The hub restarted under this peer.
      if (snapshot.bootId !== pooled.bootId) {
        await lease.replace();
        return { replaced: true };
      }
      // 8. The request itself. The pool sees a peer's JSON-RPC answer as a
      // result, so it does not count as a failure of the peer.
      const outcome = await lease.request(
        snapshot.seq,
        admission,
        async (signal): Promise<{ value: T } | { answered: true }> => {
          try {
            return { value: await send(lease.peer.peer, signal) };
          } catch (error) {
            if (peerAnswered(error)) return { answered: true };
            // A request that timed out inside the SDK ends the peer: the server
            // may keep working.
            if (
              error instanceof McpError &&
              error.code === ErrorCode.RequestTimeout
            )
              throw new RuntimeFault('timed_out');
            throw error;
          }
        },
      );
      if ('answered' in outcome) throw new PeerAnswered();
      const value = outcome.value;
      // A result that carries a credential never leaves the bridge and the
      // peer that produced it is closed below.
      lease.peer.peer.assertPublic(value);
      return { replaced: false, value };
    } catch (error) {
      // Anything but a stale tool, a JSON-RPC error the peer answered or an
      // abandoned operation ends the entry: a refused validation, an
      // unreadable registry, a modified package, a protocol failure or an
      // echoed credential.
      if (
        !(error instanceof StaleTool) &&
        !(error instanceof PeerAnswered) &&
        !abandoned(lease, error)
      )
        lease.invalidate();
      throw error;
    }
  };

  const list = async (
    connector: Connector,
    signal: AbortSignal,
    budget: number,
  ): Promise<Tool[]> => {
    const collected: Tool[] = [];
    // The tools are registered under the definition of the listing snapshot.
    const expectedHash = definitionHash(connector);
    await pool.use(connector.id, signal, listTimeout, async (lease) => {
      // The operation window covers every request of this operation, on
      // whichever peer serves it.
      let windowPeer = lease.peer.peer;
      windowPeer.beginOperation?.();
      try {
        let admission = true;
        let cursor: string | undefined;
        let replacements = 0;
        for (let page = 0; page < 8; page++) {
          const outcome = await dispatch<ListToolsResult>(
            connector,
            expectedHash,
            lease,
            admission,
            listTimeout,
            (peer, requestSignal) =>
              peer.client.request(
                {
                  method: 'tools/list',
                  params: cursor ? { cursor } : {},
                },
                ListToolsResultSchema,
                { signal: requestSignal, timeout: listTimeout },
              ),
          );
          if (outcome.replaced) {
            // The hub restarted: the partial pages are discarded and the
            // connector is listed once more on the fresh peer.
            if (++replacements > maxReplacements) throw new PeerRefused();
            windowPeer.endOperation?.();
            windowPeer = lease.peer.peer;
            windowPeer.beginOperation?.();
            admission = true;
            cursor = undefined;
            collected.length = 0;
            page = -1;
            continue;
          }
          admission = false;
          for (const tool of outcome.value.tools) {
            if (collected.length >= budget) break;
            collected.push(tool);
          }
          if (!outcome.value.nextCursor || collected.length >= budget) break;
          cursor = outcome.value.nextCursor;
        }
      } finally {
        windowPeer.endOperation?.();
      }
    });
    return collected;
  };

  const call = async (
    connector: Connector,
    expectedHash: string,
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> =>
    pool.use(connector.id, signal, callTimeout, async (lease) => {
      // The operation window covers the request of this operation, on
      // whichever peer serves it.
      let windowPeer = lease.peer.peer;
      windowPeer.beginOperation?.();
      try {
        for (let attempt = 0; attempt <= maxReplacements; attempt++) {
          const outcome = await dispatch<CallToolResult>(
            connector,
            expectedHash,
            lease,
            true,
            callTimeout,
            (peer, requestSignal) =>
              peer.client.request(
                {
                  method: 'tools/call',
                  params: { name: tool, arguments: args },
                },
                CallToolResultSchema,
                { signal: requestSignal, timeout: callTimeout },
              ),
          );
          if (!outcome.replaced) return outcome.value;
          windowPeer.endOperation?.();
          windowPeer = lease.peer.peer;
          windowPeer.beginOperation?.();
        }
        throw new PeerRefused();
      } finally {
        windowPeer.endOperation?.();
      }
    });

  return {
    async snapshot() {
      try {
        return await session.snapshot();
      } catch {
        throw new RegistryUnavailable();
      }
    },
    list,
    call,
    async reconcile() {
      await session
        .snapshot((result) => {
          const failed = 'failed' in result;
          const pending = failed && result.pending === true;
          pool.reconcile(result.seq, (entry, pooled) => {
            // A ledger whose only open entry is a prepared mutation defers
            // the decision: its result changes the ledger again and the next
            // reconciliation checks every connector on its own. No request is
            // dispatched meanwhile, because every dispatch reads the same
            // blocked ledger and fails closed.
            if (pending) return 'keep';
            // Any other failed read invalidates every idle entry; a busy one
            // fails at its own next validation, which takes a later snapshot.
            if (failed) return entry.busy ? 'keep' : 'invalidate';
            if (!pooled) return 'invalidate';
            const snapshot = result as BridgeSnapshot;
            const connector = snapshot.state.connectors.find(
              (item) => item.id === entry.key,
            );
            // Revocation is checked against this generation's own stamps and
            // wins over a graceful boot retirement.
            if (!connector || !connector.enabled || !approved(connector))
              return 'invalidate';
            if (definitionHash(connector) !== pooled.definitionHash)
              return 'invalidate';
            if (
              credentialStamp(connector, snapshot.state) !== pooled.credentials
            )
              return 'invalidate';
            if (snapshot.bootId !== pooled.bootId) return 'retire';
            return 'keep';
          });
        })
        .catch(() => undefined);
      await server.sendToolListChanged().catch(() => undefined);
    },
    async close() {
      closed = true;
      if (changedTimer !== undefined) session.clearTimer(changedTimer);
      changedTimer = undefined;
      // One absolute deadline for every cleanup of this shutdown: the
      // pooled peers and a startup that fails while the bridge leaves
      // share it.
      if (budget) budget.deadline = session.now() + poolCloseDeadline;
      await pool.close(poolCloseDeadline);
    },
  };
}

// The Docker peer of the bridge: the admission of the agent, the launch of
// the container and the handshake. A startup that fails during the
// shutdown cleans up on the budget that is left of the shutdown.
export async function connectDockerPeer(
  connector: Extract<Connector, { executionMode: 'docker' }>,
  signal: AbortSignal,
  died: (() => void) | undefined,
  runtime: BridgeDockerRuntime,
  budget: ShutdownBudget,
): Promise<BridgePeer> {
  const client = new Client(
    { name: 'waleed-managed-agent', version: '0.1.0' },
    { capabilities: {} },
  );
  let docker: Awaited<ReturnType<typeof dockerAgentTransport>> | undefined;
  try {
    // The admission: the recovery round of the agent and its refusal
    // rules run before any container starts.
    await runtime.ownership.admit();
    docker = await dockerAgentTransport(
      connector,
      signal,
      runtime.session,
      runtime.ownership,
    );
    // The container peer: the same window and death wiring as a native
    // process, whether it is pooled or not.
    return await pooledSessionPeer(
      client,
      docker.transport,
      died,
      async (deadline) => {
        await docker?.dispose(deadline);
      },
      undefined,
    );
  } catch (error) {
    try {
      await client.close();
    } finally {
      try {
        // The cleanup of a failed startup runs on the budget of the
        // shutdown that is running: no fresh bound is created here.
        await docker?.dispose(budget.deadline);
      } finally {
        /* The container of a failed startup is gone or owed to the
           recovery. */
      }
    }
    throw error;
  }
}

// The Docker runtime of one bridge: the installation id of install.json,
// the liveness listener of this bridge and the ownership of its agent. A
// failed attempt leaves no listener behind, so the next attempt may listen
// on the same pipe again.
export interface BridgeDockerRuntimeOptions {
  directory: string;
  agentId: string;
  bridgeId: string;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  // The factory of the Docker session: the production code discovers the
  // CLI of the machine.
  createSession?: (
    directory: string,
    signal: AbortSignal,
    now: () => number,
  ) => Promise<DockerSession>;
}

export async function createBridgeDockerRuntime(
  options: BridgeDockerRuntimeOptions,
): Promise<BridgeDockerRuntime> {
  // The installation id names every pipe and every label of this
  // installation.
  const install = await readInstallRecord(options.directory);
  // The liveness listener exists before any marker or container; a
  // listener that fails refuses the Docker peers of this bridge.
  const listener = await listenBridge(install.installId, options.bridgeId);
  try {
    const session = await (
      options.createSession ??
      ((directory, signal, now) => createDockerSession(directory, signal, now))
    )(options.directory, AbortSignal.timeout(20_000), options.now);
    const ownership = createDockerOwnership({
      docker: session.command,
      directory: options.directory,
      agentId: options.agentId,
      bridgeId: options.bridgeId,
      installId: install.installId,
      now: options.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
    return { session, ownership, listener };
  } catch (error) {
    // The failed attempt closes the listener it opened: the next attempt
    // may listen on the same pipe again.
    await listener.close();
    throw error;
  }
}

// The retry of the startup recovery of the agent: a bridge whose Docker
// initialization failed tries again, because the Docker daemon of the
// machine may come up after the bridge started. The retry continues only
// while the agent can still owe a cleanup, and the shutdown cancels it.
export interface StartupRecoveryRetryOptions {
  // Whether the agent can still owe a cleanup: a marker, an uncertain
  // inventory, an enabled Docker connector or the durable flag.
  due(): Promise<boolean>;
  // One recovery round of the agent. It throws when the Docker
  // initialization failed.
  recover(): Promise<void>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  intervalMs?: number;
}

export interface StartupRecoveryRetry {
  // One attempt: a failed round arms the next one.
  attempt(): Promise<void>;
  // The shutdown: the pending attempt is cancelled.
  stop(): void;
  // Resolves when no attempt is running: the shutdown waits for it before
  // it closes the ownership of the agent.
  settled(): Promise<void>;
  // Whether an attempt is armed.
  readonly pending: boolean;
}

export function createStartupRecoveryRetry(
  options: StartupRecoveryRetryOptions,
): StartupRecoveryRetry {
  const intervalMs = options.intervalMs ?? RECOVERY_RETRY_INTERVAL_MS;
  let timer: unknown;
  let stopped = false;
  // The attempt that is running, if any.
  let running: Promise<void> | undefined;
  function arm() {
    if (stopped || timer !== undefined) return;
    timer = options.setTimer(() => {
      timer = undefined;
      void attempt();
    }, intervalMs);
  }
  function attempt(): Promise<void> {
    if (stopped) return Promise.resolve();
    // One attempt runs at a time; a second caller joins it.
    running ??= run().finally(() => {
      running = undefined;
    });
    return running;
  }
  async function run() {
    try {
      await options.recover();
      // The round ran: the ownership manager owns the schedule from now on.
      return;
    } catch {
      // The Docker initialization failed: the agent may still owe a cleanup.
    }
    if (stopped) return;
    let owed: boolean;
    try {
      owed = await options.due();
    } catch {
      // The scan cannot decide: the agent may still owe a cleanup.
      owed = true;
    }
    if (owed) arm();
  }
  return {
    attempt,
    stop() {
      stopped = true;
      if (timer !== undefined) {
        options.clearTimer(timer);
        timer = undefined;
      }
    },
    settled() {
      return running ?? Promise.resolve();
    },
    get pending() {
      return timer !== undefined;
    },
  };
}

// The startup recovery of the agent at bridge start: the marker folder of
// the agent is checked without the Docker runtime, so a bridge whose agent
// owns neither a marker nor an enabled Docker connector never creates it. A
// bridge whose Docker initialization failed retries the recovery, because
// the Docker daemon of the machine may come up after the bridge started. The
// retry continues only while the agent can still owe a cleanup, and the
// shutdown cancels it.
export interface BridgeStartupRecoveryOptions {
  directory: string;
  agentId: string;
  // Whether the agent owns an enabled Docker connector.
  hasDockerConnector(): Promise<boolean>;
  // The runtime of the bridge: it is created only when a recovery is due.
  runtime(): Promise<DockerOwnership>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  intervalMs?: number;
}

export interface BridgeStartupRecovery {
  // One attempt at bridge start: a failed Docker initialization arms the
  // next one.
  attempt(): Promise<void>;
  // The shutdown: the pending retry is cancelled.
  stop(): void;
  // Resolves when no attempt is running.
  settled(): Promise<void>;
}

export function createBridgeStartupRecovery(
  options: BridgeStartupRecoveryOptions,
): BridgeStartupRecovery {
  const retry = createStartupRecoveryRetry({
    due: async () =>
      agentOwesRecovery(
        await scanAgentMarkers(options.directory, options.agentId),
        await options.hasDockerConnector(),
      ),
    recover: async () => {
      await startDockerRecovery({
        directory: options.directory,
        agentId: options.agentId,
        hasDockerConnector: await options.hasDockerConnector(),
        runtime: options.runtime,
      });
    },
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    ...(options.intervalMs === undefined
      ? {}
      : { intervalMs: options.intervalMs }),
  });
  return { attempt: retry.attempt, stop: retry.stop, settled: retry.settled };
}

export function createAgentBridge(
  read: () => Promise<HubState>,
  connect: BridgeConnect,
  session?: BridgeSession,
  budget?: ShutdownBudget,
  limits?: Partial<PoolLimits>,
) {
  const server = new Server(
    { name: 'waleed-mcp-hub', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const names = new Map<
    string,
    { connectorId: string; hash: string; name: string }
  >();
  let active = 0;
  // Set synchronously when the bridge closes: no request is admitted and no
  // peer is launched afterwards.
  let closing = false;
  const readState = async () => {
    try {
      return await read();
    } catch {
      throw new Error(registryUnavailableText);
    }
  };
  const admitted = async <T>(action: () => Promise<T>) => {
    if (closing) throw new Error(connectorUnavailableText);
    if (active >= 2) throw new Error('Hub request concurrency limit reached.');
    active++;
    try {
      return await action();
    } finally {
      active--;
    }
  };
  const bridge = session
    ? createSessionBridge(session, connect, server, budget, limits)
    : undefined;
  // The bridge tool name of one tool, and the route it belongs to.
  const register = (connector: Connector, tool: Tool, tools: Tool[]) => {
    const name = bridgeToolName(connector, tool.name, new Set(names.keys()));
    names.set(name, {
      connectorId: connector.id,
      hash: definitionHash(connector),
      name: tool.name,
    });
    tools.push({
      ...tool,
      name,
      description: `${connector.name}: ${tool.description ?? tool.name}`.slice(
        0,
        1000,
      ),
    });
  };
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) =>
    admitted(async () => {
      const signal = AbortSignal.any([
        extra.signal,
        AbortSignal.timeout(45000),
      ]);
      const snapshot = bridge ? await bridge.snapshot() : undefined;
      const state = snapshot ? snapshot.state : await readState();
      const tools: Tool[] = [];
      names.clear();
      for (const connector of state.connectors.filter(
        (item) => item.enabled && approved(item),
      )) {
        if (signal.aborted) break;
        if (
          bridge &&
          snapshot &&
          (connector.executionMode === 'native' ||
            connector.executionMode === 'remote' ||
            connector.executionMode === 'docker')
        ) {
          // A pooled peer: one peer for the whole listing.
          let listed: Tool[];
          try {
            listed = await bridge.list(connector, signal, 256 - tools.length);
          } catch {
            // Isolate unavailable/auth-required peers; never reflect
            // diagnostics.
            listed = [];
          }
          for (const tool of listed) {
            if (tools.length >= 256) break;
            register(connector, tool, tools);
          }
        } else {
          let peer: BridgePeer | undefined;
          try {
            const peerSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(20000),
            ]);
            if (closing) throw new Error();
            peer = await connect(connector, peerSignal);
            let cursor: string | undefined;
            for (let page = 0; page < 8; page++) {
              const result = await peer.client.listTools(
                cursor ? { cursor } : {},
                { signal: peerSignal, timeout: 20000 },
              );
              peer.assertPublic(result);
              for (const tool of result.tools) {
                if (tools.length >= 256) break;
                register(connector, tool, tools);
              }
              if (!result.nextCursor || tools.length >= 256) break;
              cursor = result.nextCursor;
            }
          } catch {
            /* Isolate unavailable/auth-required peers; never reflect diagnostics. */
          } finally {
            await disposePeer(peer);
          }
        }
        if (tools.length >= 256) break;
      }
      return { tools };
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    admitted(async () => {
      const target = names.get(request.params.name);
      if (!target)
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: refreshToolsText,
            },
          ],
        };
      if (bridge) {
        // Session mode: the snapshot decides the route and the pooled peer
        // serves the call.
        let snapshot: BridgeSnapshot;
        try {
          snapshot = await bridge.snapshot();
        } catch {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: registryUnavailableText,
              },
            ],
          };
        }
        const connector = snapshot.state.connectors.find(
          (item) => item.id === target.connectorId,
        );
        // The tool the agent used is stale: the connector changed since the
        // listing.
        if (!connector || definitionHash(connector) !== target.hash)
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: refreshToolsText,
              },
            ],
          };
        if (
          session &&
          (connector.executionMode === 'native' ||
            connector.executionMode === 'remote' ||
            connector.executionMode === 'docker')
        ) {
          // The call's deadline runs on the session clock and ends with the
          // call: a finished request leaves no deadline that could fire later.
          const deadline = new AbortController();
          const timer = session.setTimer(() => {
            deadline.abort();
          }, callTimeout);
          try {
            const result = await bridge.call(
              connector,
              target.hash,
              target.name,
              request.params.arguments,
              AbortSignal.any([extra.signal, deadline.signal]),
            );
            return result;
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    error instanceof RegistryUnavailable
                      ? registryUnavailableText
                      : error instanceof StaleTool
                        ? refreshToolsText
                        : connectorUnavailableText,
                },
              ],
            };
          } finally {
            session.clearTimer(timer);
          }
        }
      }
      let peer: BridgePeer | undefined;
      try {
        const state = await readState();
        const connector = state.connectors.find(
          (item) => item.id === target.connectorId,
        );
        if (
          !connector?.enabled ||
          !approved(connector) ||
          definitionHash(connector) !== target.hash
        )
          throw new Error();
        const signal = AbortSignal.any([
          extra.signal,
          AbortSignal.timeout(60000),
        ]);
        if (closing) throw new Error();
        peer = await connect(connector, signal);
        // Recheck approval after startup, immediately before the explicit call.
        const latest = (await readState()).connectors.find(
          (item) => item.id === connector.id,
        );
        if (
          !latest?.enabled ||
          !approved(latest) ||
          definitionHash(latest) !== target.hash
        )
          throw new Error();
        const result = await peer.client.callTool(
          {
            name: target.name,
            arguments: request.params.arguments,
          },
          undefined,
          { signal, timeout: 60000 },
        );
        peer.assertPublic(result);
        return result;
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: connectorUnavailableText,
            },
          ],
        };
      } finally {
        await disposePeer(peer);
      }
    }),
  );
  const bridgeServer = server as AgentBridgeServer;
  bridgeServer.reconcile = async () => {
    await bridge?.reconcile();
  };
  // The pooled peers go first: their budget is the shutdown budget.
  const closeServer = server.close.bind(server);
  server.close = async () => {
    closing = true;
    await bridge?.close();
    await closeServer();
  };
  return bridgeServer;
}
// The largest protected file the bridge reads, and the chunk it reads it in.
const protectedLimit = 4 * 1024 * 1024;
const protectedChunk = 64 * 1024;

// A protected file is opened for reading only. On POSIX the open never blocks
// on a FIFO, never follows a link in the last component and never makes a
// terminal the controlling one; Windows has no FIFOs and its text guard below
// refuses UNC, device-namespace and pipe prefixes.
const protectedOpenFlags =
  process.platform === 'win32'
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY |
      fsConstants.O_NONBLOCK |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_NOCTTY;

// Reads a protected file through its open handle. Only the text of the path
// is checked before the open (a UNC, device-namespace or pipe prefix is never
// opened; any other non-file, such as a device node, is opened read-only and
// then refused); every file-system check runs afterwards against the handle,
// so no check result is ever used to open the path: the path must still name
// the very file that was opened, without a link, or the read is refused. The
// handle is read in bounded chunks, so a file that grows after the check is
// refused once it passes the limit, and the path is checked again after the
// read, so a file replaced during the read is refused too. Every buffer is
// zeroed on every path.
export async function readProtectedText(path: string) {
  assertSafePathText(path);
  const file = await open(path, protectedOpenFlags);
  const chunks: Buffer[] = [];
  let bytes: Buffer | undefined;
  try {
    // The identities are compared as exact integers: a Windows file id does
    // not fit in a JavaScript number.
    const opened = await file.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size > BigInt(protectedLimit)
    )
      throw new Error();
    await assertNoLinks(path);
    const named = await lstat(path, { bigint: true });
    if (
      !named.isFile() ||
      named.ino !== opened.ino ||
      named.dev !== opened.dev ||
      named.nlink !== 1n
    )
      throw new Error();
    // At most one byte more than the limit is ever read or allocated: a
    // chunk is filled completely before the next one is allocated, so many
    // short reads of a growing file never add up to more memory.
    const views: Buffer[] = [];
    let total = 0;
    let done = false;
    while (!done) {
      const chunk = Buffer.alloc(
        Math.min(protectedChunk, protectedLimit + 1 - total),
      );
      chunks.push(chunk);
      let filled = 0;
      while (filled < chunk.length) {
        const { bytesRead } = await file.read(
          chunk,
          filled,
          chunk.length - filled,
          null,
        );
        if (bytesRead === 0) {
          done = true;
          break;
        }
        filled += bytesRead;
      }
      total += filled;
      if (total > protectedLimit) throw new Error();
      views.push(chunk.subarray(0, filled));
    }
    // The path must still name the same file, of exactly the size read: a
    // file that grew after the end was reached is refused.
    const after = await lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.nlink !== 1n ||
      after.size !== BigInt(total)
    )
      throw new Error();
    bytes = Buffer.concat(views);
    return bytes.toString('utf8');
  } finally {
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    await file.close();
  }
}
async function readProtectedJson(path: string) {
  return JSON.parse(await readProtectedText(path)) as unknown;
}
export async function runAgentBridge(
  registry: string,
  agentId: string,
  options?: AgentBridgeOptions,
) {
  IntegrationAgentIdSchema.parse(agentId);
  const limits = poolLimits(options);
  const directory = dirname(registry);
  const safetyPath = join(directory, 'safety.json');
  const bootPath = join(directory, 'boot.json');
  const read = async () => {
    assertLedgerOpen(
      SafetyStateSchema.parse(await readProtectedJson(safetyPath)),
    );
    const state = StateSchema.parse(await readProtectedJson(registry));
    if (!state.integrations?.some((item) => item.agentId === agentId))
      throw new Error();
    return state;
  };
  // The ledger as raw text: two reads of the same file must be identical.
  const readLedger = async () => {
    const text = await readProtectedText(safetyPath);
    assertLedgerOpen(SafetyStateSchema.parse(JSON.parse(text)));
    return text;
  };
  // One stable snapshot: the ledger, the registry, the boot record and the
  // ledger again. A ledger that changed during the read is read once more.
  const readStable = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const first = await readLedger();
      const state = StateSchema.parse(await readProtectedJson(registry));
      if (!state.integrations?.some((item) => item.agentId === agentId))
        throw new Error();
      const boot = await readBootRecord(directory);
      const second = await readLedger();
      if (first === second) return { state, bootId: boot.bootId };
    }
    throw new Error();
  };
  // One snapshot at a time: the sequence number follows the completion order.
  let sequence = 0;
  let tail: Promise<void> = Promise.resolve();
  const takeSnapshot = async (
    inside?: (result: BridgeSnapshot | BridgeSnapshotFailure) => void,
  ): Promise<BridgeSnapshot> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let snapshot: BridgeSnapshot;
      try {
        const read = await readStable();
        sequence += 1;
        snapshot = { seq: sequence, state: read.state, bootId: read.bootId };
      } catch (error) {
        sequence += 1;
        inside?.({
          seq: sequence,
          failed: true,
          ...(error instanceof LedgerPending ? { pending: true } : {}),
        });
        throw new RegistryUnavailable();
      }
      inside?.(snapshot);
      return snapshot;
    } finally {
      release();
    }
  };
  const session: BridgeSession = {
    snapshot: takeSnapshot,
    async verify(connector, signal) {
      await verifyPackage(connector, packagesRoot(directory), signal);
    },
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  let backend: ReturnType<typeof windowsSecretStore> | undefined;
  // The Docker runtime of this bridge: the installation id of install.json,
  // the liveness listener of this bridge and the ownership of its agent. A
  // bridge that cannot read the install record refuses Docker peers; every
  // other mode is unaffected.
  const bridgeId = randomUUID();
  // The runtime that exists, if any: the shutdown closes its ownership and
  // never creates it.
  let dockerState: BridgeDockerRuntime | undefined;
  // One runtime per bridge: the whole initialization is memoized before its
  // first await, so the startup recovery and the first admission share one
  // ownership manager and one live set. A failed attempt leaves no listener
  // behind and the next admission tries again.
  const dockerRuntime = createDockerRuntimeOnce(async () => {
    const runtime = await createBridgeDockerRuntime({
      directory,
      agentId,
      bridgeId,
      now: session.now,
      setTimer: session.setTimer,
      clearTimer: session.clearTimer,
    });
    dockerState = runtime;
    return runtime;
  });
  // The budget of the shutdown sequence: the cleanup of a startup that
  // fails while the bridge leaves runs on it.
  const budget: ShutdownBudget = {};
  const connect = async (
    connector: Connector,
    signal: AbortSignal,
    diedCallback?: () => void,
  ): Promise<BridgePeer> => {
    if (connector.executionMode === 'docker') {
      // A Docker connector that needs protected values is refused before the
      // credentials are resolved and before the Docker runtime exists.
      if (
        Object.keys(connector.secretBindings).length ||
        Object.keys(connector.headerBindings).length
      )
        throw new RuntimeFault('dependency_unavailable');
      const runtime = await dockerRuntime();
      return await connectDockerPeer(
        connector,
        signal,
        diedCallback,
        runtime,
        budget,
      );
    }
    let lease: SecretLease | undefined;
    const client = new Client(
      { name: 'waleed-managed-agent', version: '0.1.0' },
      { capabilities: {} },
    );
    try {
      // A managed install is verified before the secret is resolved and before
      // any process starts.
      if (connector.executionMode === 'native' && connector.package)
        await verifyPackage(connector, packagesRoot(directory), signal);
      const bound =
        Object.keys(connector.secretBindings).length ||
        Object.keys(connector.headerBindings).length;
      if (bound) {
        backend ??= windowsSecretStore(join(directory, 'credentials'), true);
        lease = await createBindingResolver({ windows: await backend }, read)(
          connector,
          signal,
        );
      }
      if (connector.executionMode === 'remote') {
        if (!diedCallback) {
          // Not pooled: one peer per request, as before.
          await client.connect(
            safeMcpHttpTransport(
              connector.endpoint,
              connector.transport,
              signal,
              undefined,
              lease?.headers,
            ),
            { timeout: 20000 },
          );
        } else {
          // A pooled peer: one HTTP session for the whole life of the entry.
          return await remoteSessionPeer(
            client,
            connector,
            signal,
            diedCallback,
            lease,
          );
        }
      } else {
        const runner = await createWindowsProcessRunner({
          allowedExecutables: [connector.executable],
          workingDirectory: directory,
          concurrency: 1,
          // A pooled peer keeps its process for the whole session.
          session: true,
          maxTimeoutMs: 3_660_000,
        });
        const transport = new ContainedStdioTransport(
          runner,
          {
            executable: connector.executable,
            arguments: isolatedNativeArguments(connector),
            environment: {
              ...connector.environmentLiterals,
              ...lease?.environment,
            },
            timeoutMs: 3_660_000,
            outputLimitBytes: 64 * 1024 * 1024,
            session: { inputLimitBytes: 16 * 1024 * 1024 },
          },
          signal,
        );
        return await pooledSessionPeer(
          client,
          transport,
          diedCallback,
          async () => {
            /* A native peer owns no container. */
          },
          lease,
        );
      }
      return {
        client,
        ...(lease?.notAfter === undefined ? {} : { notAfter: lease.notAfter }),
        async dispose() {
          try {
            await client.close();
          } finally {
            lease?.dispose();
          }
        },
        assertPublic(value) {
          assertNoCredentialEcho(value, [
            ...Object.values(lease?.environment ?? {}),
            ...Object.values(lease?.headers ?? {}),
          ]);
        },
      };
    } catch (error) {
      try {
        await client.close();
      } finally {
        lease?.dispose();
      }
      throw error;
    }
  };
  const initial = await read();
  const server = createAgentBridge(read, connect, session, budget, limits);
  await server.connect(new StdioServerTransport());
  // The Docker connectors of the agent, as the registry sees them now: the
  // recovery of the agent is owed to every agent that owns an enabled Docker
  // connector.
  let dockerConnectorEnabled = initial.connectors.some(
    (connector) => connector.executionMode === 'docker' && connector.enabled,
  );
  const refreshDockerConnector = async () => {
    try {
      const state = await read();
      dockerConnectorEnabled = state.connectors.some(
        (connector) =>
          connector.executionMode === 'docker' && connector.enabled,
      );
    } catch {
      /* The registry is unreadable: the last known state stays. */
    }
    return dockerConnectorEnabled;
  };
  // The recovery of the agent runs at bridge start when the agent owns a
  // marker or an enabled Docker connector. The marker folder of the agent is
  // checked without the Docker runtime, so a bridge whose agent owns neither
  // never creates it. It never delays the agent.
  //
  // A bridge whose Docker initialization failed retries the recovery,
  // because the Docker daemon of the machine may come up after the bridge
  // started. The retry uses the clock of the session, and the shutdown
  // cancels it.
  const startupRecovery = createBridgeStartupRecovery({
    directory,
    agentId,
    hasDockerConnector: refreshDockerConnector,
    runtime: async () => (await dockerRuntime()).ownership,
    setTimer: session.setTimer,
    clearTimer: session.clearTimer,
  });
  void startupRecovery.attempt();
  const changed = () => {
    void server.reconcile();
  };
  watchFile(registry, { interval: 1000, persistent: false }, changed);
  watchFile(safetyPath, { interval: 1000, persistent: false }, changed);
  watchFile(bootPath, { interval: 1000, persistent: false }, changed);
  // One shutdown sequence: the watchers stop, the pooled peers go first and
  // the process leaves.
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    // The pending retry of the startup recovery is cancelled: the bridge
    // leaves and creates nothing new.
    startupRecovery.stop();
    unwatchFile(registry, changed);
    unwatchFile(safetyPath, changed);
    unwatchFile(bootPath, changed);
    // The ownership schedules no new round from here on. The startup
    // recovery and the ownership round that are running finish before the
    // process leaves, both within one shutdown budget: the bridge never
    // exits under a round that removes a container or a marker, and a round
    // cut by the budget leaves its markers to the next start.
    const ownership = dockerState?.ownership;
    void ownership?.close();
    const recovered = settleWithin(
      [startupRecovery.settled(), ownership?.settled()],
      poolCloseDeadline,
      session,
    );
    void Promise.all([server.close(), recovered])
      .then(() => ownership?.close())
      .then(
        () => {
          process.exit(code);
        },
        () => {
          process.exit(code);
        },
      );
  };
  process.stdin.once('end', () => {
    stop(0);
  });
  process.once('SIGINT', () => {
    stop(0);
  });
  process.once('SIGTERM', () => {
    stop(0);
  });
  process.once('uncaughtException', () => {
    stop(1);
  });
  process.once('unhandledRejection', () => {
    stop(1);
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runAgentBridge(process.argv[2] ?? '', process.argv[3] ?? '').catch(
    () => {
      process.stderr.write(
        'The managed hub bridge is unavailable or disconnected. Inspect local recovery and agent registration.\n',
      );
      process.exitCode = 1;
    },
  );
}
