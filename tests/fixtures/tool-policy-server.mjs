// Dedicated synthetic browser fixture. No personal connectors or settings used.
import { fileURLToPath } from 'node:url';
import { createHubServer } from '../../apps/server/dist/app.js';
import { toolPolicyFixture } from '../helpers/tool-policies.ts';
const fixture = await toolPolicyFixture(),
  port = Number(process.env.HUB_PORT),
  server = await createHubServer({
    port,
    lifecycle: fixture.hub,
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
  });
server.app.get('/api/fixture/catalog', async () => fixture.agent.listTools());
server.app.post('/api/fixture/call', async (request) => {
  const { name, approve } = request.body;
  fixture.setAnswer(
    approve
      ? { action: 'accept', content: { approve: true } }
      : { action: 'decline' },
  );
  return fixture.agent.callTool({ name });
});
server.app.get('/api/fixture/report', async () => ({
  state: await fixture.hub.inventory(),
  prompts: fixture.prompts(),
  calls: fixture.peer.methods.filter((method) => method === 'tools/call')
    .length,
}));
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
