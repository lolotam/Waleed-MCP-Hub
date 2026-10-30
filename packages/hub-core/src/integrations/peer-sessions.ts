import type { Connector, HubState, HttpClientAgentId } from '@waleed/contracts';
import { agentCanAccessConnector, agentScopeHash } from './agent-profiles.js';
import type { BridgePeer } from './bridge.js';
import { approved, definitionHash, hashData } from '../runtime/registry.js';

export const bridgeSessionLimits = {
  idleTimeoutMs: 5 * 60_000,
  maxLifetimeMs: 60 * 60_000,
  maxPeers: 32,
};
type Entry = {
  id: string;
  fingerprint: string;
  controller: AbortController;
  operations: AbortController;
  connected: boolean;
  ready: Promise<BridgePeer>;
  tail: Promise<void>;
  users: number;
  idle?: ReturnType<typeof setTimeout>;
  lifetime?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
};
function fingerprint(
  connector: Connector,
  state: HubState,
  agentId?: HttpClientAgentId,
) {
  if (!agentCanAccessConnector(state, agentId, connector.id))
    throw new Error('Connector is outside the agent tool set.');
  const ids = new Set([
    ...Object.values(connector.secretBindings),
    ...Object.values(connector.headerBindings),
  ]);
  const references = state.secretReferences.filter((ref) => ids.has(ref.id));
  if (
    !connector.enabled ||
    !approved(connector) ||
    references.length !== ids.size ||
    references.some(
      (ref) => !ref.present || !ref.ownerIds.includes(connector.id),
    )
  )
    throw new Error('Connector approval or credentials are unavailable.');
  return hashData([
    connector.revision,
    connector.name,
    definitionHash(connector),
    connector.trustApproval,
    connector.toolPolicies ?? {},
    references,
    agentScopeHash(state, agentId),
  ]);
}

export { fingerprint as peerSessionFingerprint };

// One pool belongs to one agent's MCP transport. It never shares peers/credentials
// with another bridge. Failed calls are NOT replayed: their effects may be unknown.
export function createPeerSessions(
  read: () => Promise<HubState>,
  connect: (connector: Connector, lifetime: AbortSignal) => Promise<BridgePeer>,
  options: Partial<typeof bridgeSessionLimits> = {},
  agentId?: HttpClientAgentId,
) {
  if (
    Object.keys(options).some((key) => !Object.hasOwn(bridgeSessionLimits, key))
  )
    throw new Error('Invalid bridge session limits.');
  const limits = { ...bridgeSessionLimits, ...options };
  for (const key of Object.keys(limits) as Array<keyof typeof limits>)
    if (
      !Number.isInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > bridgeSessionLimits[key]
    )
      throw new Error('Invalid bridge session limits.');
  const entries = new Map<string, Entry>();
  let closed = false;
  let shutdown: Promise<void> | undefined;
  function retire(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    clearTimeout(entry.idle);
    clearTimeout(entry.lifetime);
    // Cancel in-flight SDK requests independently of their caller's signal.
    entry.operations.abort();
    if (!entry.connected) entry.controller.abort();
    entry.closing = (async () => {
      try {
        const peer = await entry.ready;
        await peer.dispose();
      } catch {
        // Never reflect provider/credential diagnostics. Docker's owned recovery
        // markers survive uncertain cleanup and block later launches.
      } finally {
        entry.controller.abort();
        if (entries.get(entry.id) === entry) entries.delete(entry.id);
      }
    })();
    return entry.closing;
  }
  const idle = (entry: Entry) => {
    if (entry.users || entry.closing) return;
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      void retire(entry);
    }, limits.idleTimeoutMs);
    entry.idle.unref();
  };
  async function reconcile(state: HubState | null) {
    const pending: Promise<void>[] = [];
    for (const entry of entries.values()) {
      try {
        const current = state?.connectors.find((item) => item.id === entry.id);
        if (
          !current ||
          fingerprint(current, state!, agentId) !== entry.fingerprint
        )
          throw new Error();
      } catch {
        pending.push(retire(entry));
      }
    }
    await Promise.all(pending);
  }
  async function use<T>(
    connector: Connector,
    state: HubState,
    requestSignal: AbortSignal,
    action: (peer: BridgePeer, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('Bridge session is closed.');
    requestSignal.throwIfAborted();
    const key = fingerprint(connector, state, agentId);
    await reconcile(state);
    if (closed) throw new Error('Bridge session is closed.');
    let entry = entries.get(connector.id);
    while (entry?.closing) {
      await entry.closing;
      if (closed) throw new Error('Bridge session is closed.');
      requestSignal.throwIfAborted();
      // Another waiter may already have created the replacement. Never overwrite
      // it with a second process or create a peer after shutdown took its snapshot.
      entry = entries.get(connector.id);
    }
    if (!entry) {
      if (entries.size >= limits.maxPeers)
        throw new Error('Bridge session capacity reached.');
      const controller = new AbortController();
      entry = {
        id: connector.id,
        fingerprint: key,
        controller,
        operations: new AbortController(),
        connected: false,
        ready: undefined as unknown as Promise<BridgePeer>,
        tail: Promise.resolve(),
        users: 0,
      };
      const owned = entry;
      entries.set(entry.id, entry);
      entry.lifetime = setTimeout(() => {
        void retire(owned);
      }, limits.maxLifetimeMs);
      entry.lifetime.unref();
      const startup = setTimeout(() => controller.abort(), 20_000);
      startup.unref();
      entry.ready = Promise.resolve()
        .then(async () => {
          {
            const latest = await read(),
              current = latest.connectors.find(
                (item) => item.id === connector.id,
              );
            if (!current || fingerprint(current, latest, agentId) !== key)
              throw new Error('Agent tool set changed before startup.');
          }
          return connect(structuredClone(connector), controller.signal);
        })
        .then((peer) => {
          owned.connected = true;
          if (!peer.client.transport) controller.abort();
          const onclose = peer.client.onclose;
          const onerror = peer.client.onerror;
          peer.client.onclose = () => {
            try {
              onclose?.();
            } finally {
              void retire(owned);
            }
          };
          peer.client.onerror = (error) => {
            try {
              onerror?.(error);
            } finally {
              void retire(owned);
            }
          };
          if (peer.expiresAt !== undefined) {
            clearTimeout(owned.lifetime);
            owned.lifetime = setTimeout(
              () => {
                void retire(owned);
              },
              Math.max(
                0,
                Math.min(limits.maxLifetimeMs, peer.expiresAt - Date.now()),
              ),
            );
            owned.lifetime.unref();
          }
          return peer;
        })
        .finally(() => clearTimeout(startup));
    }
    const owned = entry;
    owned.users++;
    clearTimeout(owned.idle);
    const work = owned.tail.then(async () => {
      const signal = AbortSignal.any([
        requestSignal,
        owned.operations.signal,
        owned.controller.signal,
      ]);
      signal.throwIfAborted();
      const peer = await owned.ready;
      signal.throwIfAborted();
      if (peer.expiresAt !== undefined && peer.expiresAt <= Date.now())
        throw new Error('Connector credentials have expired.');
      // Approval/secret metadata may have changed while queued or starting.
      let latest: HubState;
      try {
        latest = await read();
      } catch {
        await reconcile(null);
        throw new Error('Bridge registry is unavailable.');
      }
      await reconcile(latest);
      const current = latest.connectors.find(
        (item) => item.id === connector.id,
      );
      if (!current || fingerprint(current, latest, agentId) !== key)
        throw new Error();
      signal.throwIfAborted();
      return action(peer, signal);
    });
    owned.tail = work.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await work;
    } catch (error) {
      await retire(owned);
      throw error;
    } finally {
      owned.users--;
      idle(owned);
    }
  }
  return {
    use,
    reconcile,
    close() {
      closed = true;
      return (shutdown ??= Promise.all([...entries.values()].map(retire)).then(
        () => undefined,
      ));
    },
  };
}
