import { fileURLToPath } from 'node:url';
import {
  createLifecycle,
  createPlatformCredentialStorage,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/dist/app.js';
import { memoryStore } from '../helpers/memory-store.ts';
const platform = process.env.HUB_TEST_PLATFORM;
const kind =
  platform === 'win32'
    ? 'dpapi'
    : platform === 'darwin'
      ? 'keychain'
      : 'libsecret';
let checks = 0,
  locked = false;
const storage = createPlatformCredentialStorage({
  directory: 'unused-platform-fixture',
  platform,
  open: {
    [kind]: async () => ({
      async has() {
        checks++;
        if (locked) throw new Error('SYNTHETIC-PRIVATE-NATIVE-ERROR');
        return false;
      },
      async put() {
        throw new Error('No writes permitted');
      },
      async delete() {
        throw new Error('No deletes permitted');
      },
    }),
  },
});
const hub = createLifecycle(memoryStore(), Date.now, undefined, {
  credentialStorage: storage,
  secrets: storage.backends,
});
const server = await createHubServer({
  port: Number(process.env.HUB_PORT),
  lifecycle: hub,
  webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
server.app.get('/api/fixture/report', async () => ({
  checks,
  status: storage.status(),
}));
server.app.post('/api/fixture/lock', async () => {
  locked = true;
  return { locked };
});
await server.app.listen({
  host: '127.0.0.1',
  port: Number(process.env.HUB_PORT),
});
process.send?.({
  launchUrl: `${server.origin}/#launch=${server.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void server.app.close().then(() => process.disconnect?.());
});
