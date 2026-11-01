// Synthetic onboarding fixture. No personal configuration files are accessed.
import { fileURLToPath } from 'node:url';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createBindingResolver,
  createCapabilityRuntime,
  createUpdateChecker,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/dist/app.js';
import { memoryStore } from '../helpers/memory-store.ts';
import { memorySecrets } from '../helpers/secrets.ts';
import { mcpHttpFixture } from '../helpers/mcp-http.ts';
const secret = 'SYNTHETIC_FIRST_RUN_COPY_TOKEN';
const peer = await mcpHttpFixture(`Bearer ${secret}`),
  secrets = memorySecrets(),
  store = memoryStore();
const files = new Map([
  [
    'C:\\fixture\\claude.json',
    JSON.stringify({
      mcpServers: {
        primary: {
          url: 'https://example.test/mcp',
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    }),
  ],
  [
    'C:\\fixture\\codex.toml',
    '[mcp_servers.needs_auth]\nurl="https://example.test/mcp"\n',
  ],
]);
const before = JSON.stringify([...files]);
let writes = 0;
const resolver = createBindingResolver({ windows: secrets.backend }, () =>
  store.read(),
);
const lifecycle = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
  secrets: { windows: secrets.backend },
  integrations: {
    node: 'C:\\fixture\\node.exe',
    registry: 'C:\\fixture\\state.json',
    targets: [
      {
        id: 'claude',
        name: 'Claude Code',
        paths: ['C:\\fixture\\claude.json'],
        format: 'mcpServers',
        aliases: ['claude'],
        reconnect: 'Reconnect',
      },
      {
        id: 'codex',
        name: 'Codex',
        paths: ['C:\\fixture\\codex.toml'],
        format: 'codex',
        aliases: ['codex'],
        reconnect: 'Reconnect',
      },
    ],
    files: {
      read: async (path) => files.get(path) ?? null,
      replace: async () => {
        writes++;
      },
      backup: async () => 'backup',
    },
    discovery: {
      find: async () => [],
      read: async () => ({ status: 'missing' }),
      run: async () => ({ ok: false, output: '' }),
    },
  },
  runtime: {
    discover: (connector, signal) =>
      createCapabilityRuntime({
        workingDirectory: 'http-only-fixture',
        fixtureOrigin: peer.origin,
        resolveBindings: resolver,
      }).discover({ ...connector, endpoint: `${peer.origin}/mcp` }, signal),
  },
});
const root = 'https://github.com/lolotam/Waleed-MCP-Hub',
  tag = 'v0.2.0';
const updates = createUpdateChecker('0.1.0', async () =>
  Response.json({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `${root}/releases/tag/${tag}`,
    assets: [
      {
        name: 'Waleed-MCP-Hub-Setup.exe',
        browser_download_url: `${root}/releases/download/${tag}/Waleed-MCP-Hub-Setup.exe`,
      },
    ],
  }),
);
const port = 4198;
const hub = await createHubServer({
  port,
  lifecycle,
  updates,
  webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
hub.app.get('/api/fixture-report', async () => ({
  sourceUnchanged: before === JSON.stringify([...files]) && writes === 0,
  names: (await lifecycle.inventory()).connectors.map((item) => item.name),
  credentialCopied: [...secrets.values.values()].some(
    (value) => value.toString() === `Bearer ${secret}`,
  ),
  methods: peer.methods,
}));
await hub.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${hub.origin}/#launch=${hub.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void hub.app
      .close()
      .then(() => peer.close())
      .then(() => process.disconnect?.());
});
