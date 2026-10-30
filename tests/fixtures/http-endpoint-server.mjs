import { fileURLToPath } from 'node:url';
import { createHubServer } from '../../apps/server/dist/app.js';
import { createLifecycle, memoryClientTokenStore } from '@waleed/hub-core';
import { playgroundFixture } from '../helpers/playground.ts';
import { memoryStore } from '../helpers/memory-store.ts';

const peer = playgroundFixture(),
  tokenStore = memoryClientTokenStore();
const hub = createLifecycle(memoryStore(peer.state), Date.now, undefined, {
  clientTokens: tokenStore,
  playgroundConnect: peer.connect,
});
const port = Number(process.env.HUB_PORT);
const server = await createHubServer({
  port,
  lifecycle: hub,
  webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
server.app.get('/api/fixture/report', async () => ({
  tokens: await hub.http.tokens.list(),
  records: hub.requestLogSnapshot(),
  calls: peer.calls.length,
}));
await server.app.listen({ host: '127.0.0.1', port });
process.send?.({
  launchUrl: `${server.origin}/#launch=${server.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void server.app
      .close()
      .then(() => peer.playground.close())
      .then(() => process.disconnect?.());
});
