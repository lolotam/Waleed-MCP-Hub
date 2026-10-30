import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsSecretStore,
  createBindingResolver,
  emptyState,
} from '@waleed/hub-core';
import { projectSetup } from '../../packages/hub-core/src/setup/format.js';
import { profileState } from '../helpers/runtime.js';
import { openStateStore } from '../../packages/hub-core/src/adapters/persistence.js';

it.skipIf(process.platform !== 'win32')(
  'restores a setup through real atomic state persistence and DPAPI without plaintext in files/backups',
  async () => {
    const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\setup-dpapi-'),
      vault = await windowsSecretStore(join(directory, 'credentials'));
    const store = await openStateStore(directory),
      safety = createMemorySafetyLedger(),
      hub = createLifecycle(store, Date.now, safety, {
        secrets: { windows: vault },
      }),
      secret = 'SYNTHETIC-REAL-SETUP-DPAPI-0123456789';
    try {
      expect((await store.read()).connectors).toEqual(emptyState().connectors);
      const bundle = projectSetup(profileState(['native']), Date.now());
      bundle.connectors[0]!.requiredSecrets = [
        { key: 'API_KEY', target: 'environment', format: 'raw' },
      ];
      const p = await hub.setup.preview(
        { source: JSON.stringify(bundle), conflictStrategy: 'skip_existing' },
        'owner',
      );
      await hub.setup.apply(
        {
          previewId: p.id,
          expectedRevision: p.expectedRevision,
          conflictStrategy: p.conflictStrategy,
          credentials: { 'connector-0/environment/API_KEY': secret },
        },
        'owner',
      );
      const saved = await store.read(),
        connector = saved.connectors[0]!,
        id = connector.secretBindings.API_KEY!;
      expect(await vault.has(id, AbortSignal.timeout(10000))).toBe(true);
      const lease = await createBindingResolver({ windows: vault }, () =>
        store.read(),
      )(connector, AbortSignal.timeout(10000));
      try {
        expect(lease.environment.API_KEY).toBe(secret);
      } finally {
        lease.dispose();
      }
      expect(JSON.stringify(await hub.setup.export())).not.toContain(secret);
      // A second commit exercises the existing atomic backup path too.
      const next = await hub.setup.preview(
        {
          source: JSON.stringify(bundle),
          conflictStrategy: 'overwrite_existing',
        },
        'owner',
      );
      await hub.setup.apply(
        {
          previewId: next.id,
          expectedRevision: next.expectedRevision,
          conflictStrategy: next.conflictStrategy,
          credentials: {
            'connector-0/environment/API_KEY': `${secret}-replacement`,
          },
        },
        'owner',
      );
      async function scan(path: string): Promise<void> {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const target = join(path, entry.name);
          if (entry.isDirectory()) await scan(target);
          else {
            const bytes = await readFile(target);
            try {
              for (const encoding of ['utf8', 'utf16le'] as const)
                expect(bytes.includes(Buffer.from(secret, encoding))).toBe(
                  false,
                );
              expect(
                bytes.includes(
                  Buffer.from(Buffer.from(secret).toString('base64')),
                ),
              ).toBe(false);
            } finally {
              bytes.fill(0);
            }
          }
        }
      }
      await scan(directory);
      expect((await store.read()).revision).toBe(2);
    } finally {
      await hub.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
