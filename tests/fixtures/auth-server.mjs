// Construction-only synthetic authentication backend. Never imported by production.
import { fileURLToPath } from 'node:url';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createBindingResolver,
  createCapabilityRuntime,
  definitionHash,
  emptyState,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/dist/app.js';
import { connector } from '../helpers/runtime.ts';
import { memoryStore } from '../helpers/memory-store.ts';
import { memorySecrets } from '../helpers/secrets.ts';
import { mcpHttpFixture } from '../helpers/mcp-http.ts';
import { oauthFixture } from '../helpers/oauth.ts';
import {
  beginOAuth,
  refreshOAuth,
} from '../../packages/hub-core/dist/auth/oauth-flow.js';
import { discoverOAuth } from '../../packages/hub-core/dist/auth/oauth-discovery.js';
import { hashData } from '../../packages/hub-core/dist/runtime/registry.js';

const privateValue = 'SYNTHETIC_BROWSER_APIKEY_0123456789';
const keyPeer = await mcpHttpFixture(`Bearer ${privateValue}`),
  oauthPeer = await oauthFixture(),
  secrets = memorySecrets();
const state = emptyState();
state.connectors = [connector('key'), connector('oauth')];
state.connectors[0].name = 'Synthetic API key';
state.connectors[1].name = 'Synthetic OAuth';
state.connectors[1].endpoint = 'https://example.test/oauth';
for (const item of state.connectors)
  item.trustApproval.definitionHash = definitionHash(item);
const store = memoryStore(state);
const resolver = createBindingResolver({ windows: secrets.backend }, () =>
  store.read(),
);
const lifecycle = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
  secrets: { windows: secrets.backend },
  oauthRecipes: [
    { ...oauthPeer.recipe, endpoint: 'https://example.test/oauth' },
  ],
  oauthFlows: {
    begin: (recipe, signal, now) =>
      beginOAuth(recipe.discovered ? recipe : oauthPeer.recipe, signal, now),
    refresh: (_recipe, previous, signal, now) =>
      refreshOAuth(oauthPeer.recipe, previous, signal, now),
  },
  oauthDiscovery: async (endpoint, signal) => {
    const { recipe } = await discoverOAuth(oauthPeer.recipe.endpoint, signal, {
      fixtureOrigin: oauthPeer.recipe.fixtureOrigin,
    });
    recipe.endpoint = endpoint;
    return { recipe, discoveryHash: hashData(recipe) };
  },
  runtime: {
    async discover(item, signal) {
      const endpoint =
        item.id === 'key' ? `${keyPeer.origin}/mcp` : oauthPeer.recipe.endpoint;
      return createCapabilityRuntime({
        workingDirectory: 'unused-http-only',
        fixtureOrigin:
          item.id === 'key' ? keyPeer.origin : oauthPeer.recipe.fixtureOrigin,
        resolveBindings: resolver,
      }).discover({ ...item, endpoint }, signal);
    },
  },
});
const port = Number(process.env.HUB_PORT ?? 4194);
const hub = await createHubServer({
  port,
  lifecycle,
  webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
hub.app.get('/api/fixture-report', async () => ({
  stored: secrets.values.size,
  keyMethods: keyPeer.methods,
  oauth: {
    methods: oauthPeer.methods,
    registrations: oauthPeer.report().registrations,
    tokenRequests: oauthPeer.report().tokenRequests,
  },
  retainedBuffersZeroed:
    secrets.writes.every((buffer) => buffer.every((byte) => byte === 0)) &&
    secrets.reads.every((buffer) => buffer.every((byte) => byte === 0)),
}));
hub.app.post('/api/fixture-mode', async (request) => {
  oauthPeer.setMode(request.body.mode);
  return { changed: true };
});
await hub.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${hub.origin}/#launch=${hub.issueLaunchToken()}`,
});
async function shutdown() {
  await hub.app.close();
  await keyPeer.close();
  await oauthPeer.close();
  secrets.close();
  process.disconnect?.();
}
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
