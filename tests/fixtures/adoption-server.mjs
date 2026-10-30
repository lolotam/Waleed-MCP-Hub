// Synthetic user-file/vault seams only. No personal configuration is accessed.
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsAgentTargets,
  createRegistryClient,
  parseRegistryServer,
  createCapabilityRuntime,
  createBindingResolver,
  createMcpbAdapter,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/dist/app.js';
import { memoryStore } from '../helpers/memory-store.ts';
import { memorySecrets } from '../helpers/secrets.ts';
import { profileState } from '../helpers/runtime.ts';
import { mcpHttpFixture } from '../helpers/mcp-http.ts';
const secrets = memorySecrets(),
  target = windowsAgentTargets('C:\\Synthetic', {}).find(
    (target) => target.id === 'cursor',
  );
const privateValue = 'SYNTHETIC-BROWSER-ADOPTION-PRIVATE';
const localPeer = await mcpHttpFixture(),
  store = memoryStore(profileState([]));
const bundleDirectory = await mkdtemp(
  'E:\\Dev\\Temp\\opencode\\browser-bundles-',
);
let source = `{// Keep this comment\n"theme":"keep","mcpServers":{"Imported":{"command":"npx","args":["synthetic-mcp@1.2.3"],"env":{"TOKEN":"${privateValue}"}}}}`;
const lifecycle = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
  secrets: { windows: secrets.backend },
  bundles: createMcpbAdapter(bundleDirectory, { node: process.execPath }),
  runtime: createCapabilityRuntime({
    workingDirectory: 'unused-http-only',
    resolveBindings: createBindingResolver({ windows: secrets.backend }, () =>
      store.read(),
    ),
  }),
  integrations: {
    targets: [target],
    files: {
      read: async (path) => (path === target.paths[0] ? source : null),
      replace: async (_path, before, after) => {
        if (source !== before) throw new Error();
        source = after;
      },
      backup: async () => {
        throw new Error('No plaintext backups');
      },
    },
    registry: 'C:\\Synthetic\\state.json',
    node: process.execPath,
    discovery: {
      find: async () => ['C:\\Synthetic\\cursor.exe'],
      read: async () => ({ status: 'missing' }),
      run: async () => {
        throw new Error('No execution');
      },
    },
  },
});
const registry = createRegistryClient();
registry.search = async () => ({
  source: 'https://registry.modelcontextprotocol.io',
  nextCursor: null,
  servers: [
    parseRegistryServer({
      server: {
        name: 'io.github.synthetic/registry-tools',
        title: 'Registry Tools',
        description: 'Synthetic reviewed package suggestion',
        version: '1.2.3',
        packages: [
          {
            registryType: 'npm',
            identifier: 'synthetic-registry-mcp',
            version: '1.2.3',
            transport: { type: 'stdio' },
            environmentVariables: [
              {
                name: 'API_TOKEN',
                isRequired: true,
                isSecret: true,
                default: 'SYNTHETIC-PUBLISHER-DO-NOT-PREFILL',
              },
            ],
          },
        ],
      },
      _meta: {
        'io.modelcontextprotocol.registry/official': { status: 'active' },
      },
    }),
  ],
});
const port = Number(process.env.HUB_PORT ?? 4197),
  server = await createHubServer({
    port,
    lifecycle,
    registry,
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
  });
server.app.get(
  '/api/fixture-report',
  { config: { public: true } },
  async () => ({
    state: await lifecycle.inventory(),
    sourceContainsSecret: source.includes(privateValue),
    preservedComment: source.includes('Keep this comment'),
    hasBridge: source.includes('waleed-mcp-hub'),
    localEndpoint: `${localPeer.origin}/mcp`,
    localMethods: localPeer.methods,
    buffersCleared: secrets.writes.every((bytes) =>
      bytes.every((byte) => byte === 0),
    ),
  }),
);
await server.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${server.origin}/#launch=${server.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void server.app.close().then(async () => {
      await localPeer.close();
      secrets.close();
      await rm(bundleDirectory, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 100,
      });
      process.disconnect?.();
    });
});
