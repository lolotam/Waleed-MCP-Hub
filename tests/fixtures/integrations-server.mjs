import { tmpdir } from 'node:os';
// Disposable Windows-user scopes only; no personal config/pilot reads or writes.
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsAgentTargets,
  agentFiles,
} from '@waleed/hub-core';
import { memoryStore } from '../helpers/memory-store.ts';
import { memorySecrets } from '../helpers/secrets.ts';
import { createHubServer } from '../../apps/server/dist/app.js';
const directory = await mkdtemp(join(tmpdir(), 'hub-p7-browser-'));
const targets = windowsAgentTargets('C:\\Synthetic', {}).map((target) => ({
  ...target,
  paths: [
    join(
      directory,
      target.id,
      target.format === 'codex' ? 'config.toml' : 'config.json',
    ),
  ],
}));
for (const target of targets) {
  await mkdir(dirname(target.paths[0]), { recursive: true });
  await writeFile(
    target.paths[0],
    target.format === 'codex'
      ? '# keep node_repl\n[tools]\nnode_repl=true\n'
      : '{\n// keep plugins\n"plugins": ["keep"]\n}',
  );
}
const secrets = memorySecrets();
const lifecycle = createLifecycle(
  memoryStore(),
  Date.now,
  createMemorySafetyLedger(),
  {
    secrets: { windows: secrets.backend, docker: secrets.backend },
    integrations: {
      targets,
      files: agentFiles(
        targets.flatMap((target) => target.paths),
        join(directory, 'backups'),
        async () => undefined,
      ),
      registry: join(directory, 'state.json'),
      node: process.execPath,
      bridge: 'C:\\Synthetic\\bridge.js',
      discovery: {
        async find() {
          return [process.execPath];
        },
        async read(path) {
          const target = targets.find(
            (item) => item.packageName && path.includes(item.packageName),
          );
          return target
            ? {
                status: 'read',
                text: JSON.stringify({
                  name: target.packageName,
                  version: '2.0.0',
                }),
                fingerprint: '0'.repeat(64),
              }
            : { status: 'missing' };
        },
        async run() {
          throw new Error('Scanning must not start agents.');
        },
      },
    },
  },
);
const hub = await createHubServer({
  port: 4195,
  lifecycle,
  webRoot: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
await hub.app.listen({ host: '127.0.0.1', port: 4195 });
process.send?.({
  launchUrl: `${hub.origin}/#launch=${hub.issueLaunchToken()}`,
});
process.on('message', (message) => {
  if (message === 'shutdown')
    void hub.app.close().then(async () => {
      secrets.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
      process.disconnect?.();
    });
});
