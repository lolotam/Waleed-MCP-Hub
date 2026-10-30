import type { Connector, HubState } from '@waleed/contracts';
import type { SecretBackends } from './secrets.js';
import { createBindingResolver, type SecretLease } from './bindings.js';
import { createOAuthTokenManager } from './oauth-tokens.js';
import { sameDefinition } from './credentials.js';
import { definitionHash } from '../runtime/registry.js';

// Used by both SSE and Streamable HTTP. A transport cannot cache Bearer headers
// for its full session: each request revalidates the binding and refreshes first.
export function createRemoteCredentials(
  backends: SecretBackends,
  read: () => Promise<HubState>,
  connector: Connector,
  lifetime: AbortSignal,
  now: () => number = Date.now,
) {
  const ensure = createOAuthTokenManager(backends, read, now);
  const resolve = createBindingResolver(backends, read, now);
  let lease: SecretLease | undefined,
    closed = false;
  let tail = Promise.resolve();
  return {
    headers(): Promise<Record<string, string>> {
      const result = tail.then(async () => {
        if (closed) throw new Error('Credential provider closed.');
        lease?.dispose();
        lease = undefined;
        const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
        signal.throwIfAborted();
        const current = (await read()).connectors.find(
          (item) => item.id === connector.id,
        );
        if (
          !current ||
          !sameDefinition(
            current,
            connector.revision,
            definitionHash(connector),
          )
        )
          throw new Error('Connector approval changed.');
        await ensure(connector, signal);
        const fresh = await resolve(connector, signal);
        if (closed || signal.aborted) {
          fresh.dispose();
          throw new Error('Credential provider closed.');
        }
        lease = fresh;
        return { ...lease.headers };
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    values() {
      return Object.values(lease?.headers ?? {});
    },
    async dispose() {
      closed = true;
      lease?.dispose();
      lease = undefined;
      await tail;
    },
  };
}
