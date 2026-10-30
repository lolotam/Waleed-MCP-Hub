import { fileURLToPath } from 'node:url';
import { createHubServer } from '../../apps/server/dist/app.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
} from '../../packages/hub-core/dist/index.js';
import { profileState } from '../helpers/runtime.ts';
import { memoryStore } from '../helpers/memory-store.ts';
import { memorySecrets } from '../helpers/secrets.ts';
const state = profileState(['native']);
state.connectors[0].secretBindings = { API_KEY: 'fixture-protected' };
state.secretReferences = [
  {
    id: 'fixture-protected',
    adapter: 'windows',
    present: true,
    ownerIds: ['connector-0'],
  },
];
const vault = memorySecrets();
vault.values.set(
  'fixture-protected',
  Buffer.from('SYNTHETIC-FIXTURE-PROTECTED'),
);
const store = memoryStore(state),
  hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
    secrets: { windows: vault.backend },
  }),
  port = Number(process.env.HUB_PORT),
  server = await createHubServer({
    port,
    lifecycle: hub,
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
  });
server.app.get('/api/fixture/report', async () => ({
  state: await hub.inventory(),
  vaultCount: vault.values.size,
  clearedWrites: vault.writes.every((bytes) =>
    bytes.every((value) => value === 0),
  ),
}));
await server.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${server.origin}/#launch=${server.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void server.app
      .close()
      .then(() => hub.close())
      .then(() => {
        vault.close();
        process.disconnect?.();
      });
});
