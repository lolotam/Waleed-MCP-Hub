import { fileURLToPath } from 'node:url';
import { createHubServer } from '../../apps/server/dist/app.js';
import { moreAgentsFixture } from '../helpers/more-agents.ts';
const f = moreAgentsFixture(),
  port = Number(process.env.HUB_PORT),
  server = await createHubServer({
    port,
    lifecycle: f.hub,
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
  });
server.app.get('/api/fixture/report', async () => ({
  effects: f.effects(),
  state: await f.hub.inventory(),
}));
await server.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${server.origin}/#launch=${server.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void server.app
      .close()
      .then(() => f.close())
      .then(() => process.disconnect?.());
});
