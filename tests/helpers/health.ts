import { randomUUID } from 'node:crypto';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createCapabilityRuntime,
  createBindingResolver,
  definitionHash,
  HubError,
  type StartupRegistration,
} from '@waleed/hub-core';
import { profileState } from './runtime.js';
import { memoryStore } from './memory-store.js';
import { memorySecrets } from './secrets.js';
import { mcpHttpFixture } from './mcp-http.js';

export async function healthFixture() {
  const peer = await mcpHttpFixture(),
    secrets = memorySecrets(),
    state = profileState(['remote', 'remote', 'remote']);
  for (const [index, connector] of state.connectors.entries()) {
    if (connector.executionMode !== 'remote') throw new Error();
    connector.endpoint = `${peer.origin}/${index === 2 ? 'auth' : 'mcp'}`;
    connector.localHttpOptIn = true;
    connector.name = ['Healthy connector', 'Expired OAuth', 'Revoked OAuth'][
      index
    ]!;
    if (index) {
      const id = `wmh-secret-${randomUUID()}`;
      state.secretReferences.push({
        id,
        adapter: 'windows',
        kind: 'oauth',
        recipeId: 'synthetic',
        present: true,
        ownerIds: [connector.id],
      });
      connector.headerBindings = { Authorization: id };
      connector.credentialFormats = { Authorization: 'bearer' };
      secrets.values.set(
        id,
        Buffer.from(
          JSON.stringify({
            accessToken: 'SYNTHETIC-HEALTH-ACCESS-PRIVATE',
            refreshToken: 'SYNTHETIC-HEALTH-REFRESH-PRIVATE',
            expiresAt: Date.now() + (index === 1 ? -60000 : 3600000),
            clientId: 'synthetic',
          }),
        ),
      );
    }
    connector.trustApproval!.definitionHash = definitionHash(connector);
  }
  let startupState: 'enabled' | 'disabled' | 'conflict' = 'disabled',
    startupWrites = 0;
  const startup: StartupRegistration = {
    async query() {
      return {
        available: true,
        state: startupState,
        enabled: startupState === 'enabled',
      };
    },
    async set(enabled, expected) {
      if (startupState !== expected)
        throw new HubError('conflict', 'Synthetic startup conflict.');
      startupState = enabled ? 'enabled' : 'disabled';
      startupWrites++;
      return startup.query();
    },
  };
  const store = memoryStore(state),
    hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      secrets: { windows: secrets.backend },
      startup,
      runtime: createCapabilityRuntime({
        workingDirectory: 'unused-health-http-only',
        resolveBindings: createBindingResolver(
          { windows: secrets.backend },
          () => store.read(),
        ),
      }),
    });
  return {
    hub,
    store,
    secrets,
    peer,
    startupWrites: () => startupWrites,
    setStartupConflict() {
      startupState = 'conflict';
    },
    async close(closeHub = true) {
      if (closeHub) await hub.close();
      await peer.close();
      secrets.close();
    },
  };
}
