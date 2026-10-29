// Synthetic browser-test backend only. Production startup never imports this.
import { fileURLToPath } from 'node:url';
import {
  createDiscoveryService,
  createLifecycle,
  emptyState,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/dist/app.js';
import { discoveryFixture } from './discovery.ts';

const fixture = discoveryFixture();
const scenario = process.env.HUB_TEST_SCENARIO ?? 'healthy';
const original = fixture.ports.run;
if (scenario === 'docker_down')
  fixture.ports.run = async (...args) =>
    args[1][0] === 'version' ? { ok: false, output: '' } : original(...args);
if (scenario === 'slow')
  fixture.ports.run = async (_exe, _args, _env, signal) => {
    if (!signal.aborted)
      await new Promise((resolve) =>
        signal.addEventListener('abort', resolve, { once: true }),
      );
    return { ok: false, output: '' };
  };
let state = emptyState();
const store = {
  async read() {
    return structuredClone(state);
  },
  async write(_revision, next) {
    state = structuredClone(next);
  },
  async close() {},
};
const discovery = createDiscoveryService(fixture.ports, fixture.settings);
const port = Number(process.env.HUB_PORT ?? 4190);
const hub = await createHubServer({
  port,
  lifecycle: createLifecycle(store),
  discovery,
  webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
await hub.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${hub.origin}/#launch=${hub.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void hub.app.close().then(() => process.disconnect?.());
});
process.once('SIGTERM', () => {
  void hub.app.close();
});
