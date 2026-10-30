// Synthetic multi-agent/profile browser fixture, never loaded by production.
import { fileURLToPath } from 'node:url';
import { createHubServer } from '../../apps/server/dist/app.js';
import { agentProfilesFixture } from '../helpers/agent-profiles.ts';
const fixture = await agentProfilesFixture({
    echoArguments: process.env.PLAYGROUND_ECHO === '1',
  }),
  port = Number(process.env.HUB_PORT),
  server = await createHubServer({
    port,
    lifecycle: fixture.hub,
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
  });
server.app.get('/api/fixture/agents/:agentId/catalog', async (request) =>
  fixture.agents.get(request.params.agentId)?.client.listTools(),
);
server.app.post('/api/fixture/agents/:agentId/call', async (request) =>
  fixture.agents.get(request.params.agentId)?.client.callTool({
    name: request.body.name,
    arguments: request.body.arguments,
  }),
);
server.app.get('/api/fixture/report', async () => ({
  state: await fixture.hub.inventory(),
  effects: fixture.fileEffects(),
  calls: fixture.peers.map(
    (peer) => peer.methods.filter((method) => method === 'tools/call').length,
  ),
  contentReads: fixture.peers.map(
    (peer) =>
      peer.methods.filter((method) => method === 'resources/read').length,
  ),
  promptGets: fixture.peers.map(
    (peer) => peer.methods.filter((method) => method === 'prompts/get').length,
  ),
}));
server.app.get('/api/fixture/agents/:agentId/resources', async (request) =>
  fixture.agents.get(request.params.agentId)?.client.listResources(),
);
server.app.get('/api/fixture/agents/:agentId/templates', async (request) =>
  fixture.agents.get(request.params.agentId)?.client.listResourceTemplates(),
);
server.app.get('/api/fixture/agents/:agentId/prompts', async (request) =>
  fixture.agents.get(request.params.agentId)?.client.listPrompts(),
);
server.app.post('/api/fixture/agents/:agentId/resource-read', async (request) =>
  fixture.agents
    .get(request.params.agentId)
    ?.client.readResource({ uri: request.body.uri }),
);
server.app.post('/api/fixture/agents/:agentId/prompt-get', async (request) =>
  fixture.agents.get(request.params.agentId)?.client.getPrompt({
    name: request.body.name,
    arguments: request.body.arguments,
  }),
);
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
