// Synthetic browser-test backend. Production never imports or enables this.
import { fileURLToPath } from 'node:url';
import {
  createDiscoveryService,
  createLifecycle,
  createMemorySafetyLedger,
  RuntimeFault,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/dist/app.js';
import { discoveryFixture } from './discovery.ts';
import { managedFixture } from '../helpers/materialization.ts';
import { memoryStore } from '../helpers/memory-store.ts';
import { mcpHttpFixture } from '../helpers/mcp-http.ts';
import { enumerateCapabilities } from '../../packages/hub-core/dist/runtime/capabilities.js';
import { safeMcpHttpTransport } from '../../packages/hub-core/dist/adapters/mcp/http.js';

const peer = await mcpHttpFixture();
const fixture = managedFixture();
const discovery = discoveryFixture();
const lifecycle = createLifecycle(
  memoryStore(),
  Date.now,
  createMemorySafetyLedger(),
  {
    materializer: fixture.materializer,
    runtime: {
      async discover(connector, signal) {
        if (connector.executionMode !== 'remote')
          throw new RuntimeFault('adapter_pending');
        return enumerateCapabilities(
          safeMcpHttpTransport(
            `${peer.origin}/${connector.endpoint.endsWith('/auth') ? 'auth' : 'mcp'}`,
            'streamable_http',
            signal,
            peer.origin,
          ),
          signal,
        );
      },
    },
  },
);
const port = Number(process.env.HUB_PORT ?? 4193);
const hub = await createHubServer({
  port,
  lifecycle,
  discovery: createDiscoveryService(discovery.ports, discovery.settings),
  webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
hub.app.get('/api/fixture-report', async () => ({
  methods: peer.methods,
  managedFiles: fixture.disk.size,
  dockerProfiles: fixture.profiles.size,
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
process.once('SIGTERM', () => {
  void hub.app.close().then(() => peer.close());
});
