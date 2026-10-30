import { fileURLToPath } from 'node:url';
import { createHubServer } from '../../apps/server/dist/app.js';
import {
  createLifecycle,
  windowsAgentTargets,
  createMemorySafetyLedger,
} from '../../packages/hub-core/dist/index.js';
import { memoryStore } from '../helpers/memory-store.ts';
const targets = windowsAgentTargets('C:\\SyntheticOnboarding', {}).filter(
    (target) =>
      ['claude-desktop', 'cursor', 'vscode', 'codex', 'opencode'].includes(
        target.id,
      ),
  ),
  sources = new Map(
    targets.map((target) => [
      target.paths[0],
      target.format === 'codex'
        ? '# Synthetic Codex\nmodel = "keep"\n'
        : target.format === 'opencode'
          ? '{}'
          : '{"theme":"keep"}',
    ]),
  );
let writes = 0,
  backups = 0,
  probes = 0;
const hub = createLifecycle(
    memoryStore(),
    Date.now,
    createMemorySafetyLedger(),
    {
      integrations: {
        targets,
        files: {
          read: async (path) => sources.get(path) ?? null,
          async replace(path, before, after) {
            if (sources.get(path) !== before) throw new Error();
            sources.set(path, after);
            writes++;
          },
          async backup(agentId) {
            backups++;
            return `C:\\SyntheticOnboarding\\${agentId}.bak`;
          },
        },
        node: process.execPath,
        registry: 'C:\\SyntheticOnboarding\\state.json',
        discovery: {
          find: async (names) => {
            probes++;
            return [`C:\\SyntheticOnboarding\\${names[0]}.exe`];
          },
          read: async () => ({ status: 'missing' }),
          run: async () => {
            throw new Error('No agent execution.');
          },
        },
      },
    },
  ),
  port = Number(process.env.HUB_PORT),
  server = await createHubServer({
    port,
    lifecycle: hub,
    webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
  });
server.app.get('/api/fixture/report', async () => ({
  writes,
  backups,
  probes,
  state: await hub.inventory(),
  onboarding: await hub.settings.onboarding(),
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
      .then(() => process.disconnect?.());
});
