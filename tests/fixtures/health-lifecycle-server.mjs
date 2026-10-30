import { fileURLToPath } from 'node:url';
import { createHubServer } from '../../apps/server/dist/app.js';
import { healthFixture } from '../helpers/health.ts';
const fixture = await healthFixture(),
  port = Number(process.env.HUB_PORT),
  server = await createHubServer({
    port,
    lifecycle: fixture.hub,
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    shutdown: () => {},
  });
server.app.get('/api/fixture/report', async () => ({
  methods: fixture.peer.methods,
  startupWrites: fixture.startupWrites(),
}));
server.app.post('/api/fixture/startup-conflict', async () => {
  fixture.setStartupConflict();
  return { changed: true };
});
await server.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${server.origin}/#launch=${server.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void server.app
      .close()
      .then(() => fixture.close(false))
      .then(() => process.disconnect?.());
});
