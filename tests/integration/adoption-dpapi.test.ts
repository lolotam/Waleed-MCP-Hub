import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsSecretStore,
  windowsAgentTargets,
  agentFiles,
} from '@waleed/hub-core';
import { profileState } from '../helpers/runtime.js';
import { memoryStore } from '../helpers/memory-store.js';
it.skipIf(process.platform !== 'win32')(
  'real DPAPI adoption removes source keys without creating plaintext configs, temps, state or backups',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-adoption-dpapi-')),
      path = join(root, 'cursor.jsonc'),
      vault = await windowsSecretStore(join(root, 'credentials'));
    const privateValue = 'SYNTHETIC-REAL-DPAPI-ADOPTION-0123456789';
    const original = `{// preserve settings\n"theme":"keep","mcpServers":{"Private":{"command":"npx","args":["synthetic@1.2.3"],"env":{"TOKEN":"${privateValue}"}}}}`;
    await writeFile(path, original);
    const target = {
      ...windowsAgentTargets('C:\\Synthetic', {}).find(
        (target) => target.id === 'cursor',
      )!,
      paths: [path],
    };
    const hub = createLifecycle(
      memoryStore(profileState([])),
      Date.now,
      createMemorySafetyLedger(),
      {
        secrets: { windows: vault },
        integrations: {
          targets: [target],
          files: agentFiles([path], join(root, 'plaintext-backups')),
          node: process.execPath,
          registry: join(root, 'state.json'),
          discovery: {
            find: async () => [],
            read: async () => ({ status: 'missing' }),
            run: async () => {
              throw new Error();
            },
          },
        },
      },
    );
    try {
      const preview = await hub.adoption.preview(
        'cursor',
        { expectedRevision: 0 },
        'owner',
      );
      const receipt = await hub.adoption.apply(
        preview.id,
        {
          expectedRevision: 0,
          profileIds: ['profile'],
          confirmImport: true,
          confirmAgentConfigChange: true,
        },
        'owner',
      );
      await writeFile(
        join(root, 'state.json'),
        JSON.stringify(await hub.inventory()),
      );
      for (const directory of [root, join(root, 'credentials')])
        for (const entry of await readdir(directory, { withFileTypes: true }))
          if (entry.isFile()) {
            const bytes = await readFile(join(directory, entry.name));
            try {
              expect(bytes.includes(Buffer.from(privateValue))).toBe(false);
              expect(
                bytes.includes(
                  Buffer.from(Buffer.from(privateValue).toString('base64')),
                ),
              ).toBe(false);
            } finally {
              bytes.fill(0);
            }
          }
      expect(await readdir(root)).not.toContain('plaintext-backups');
      const encryptedManifest = await vault.read!(
        receipt.encryptedRecoveryIds.at(-1)!,
        AbortSignal.timeout(15000),
      );
      try {
        const manifest = JSON.parse(encryptedManifest.toString()) as {
          chunks: string[];
        };
        const chunks: Buffer[] = [];
        try {
          for (const id of manifest.chunks)
            chunks.push(await vault.read!(id, AbortSignal.timeout(15000)));
          expect(Buffer.concat(chunks).toString()).toBe(original);
        } finally {
          chunks.forEach((bytes) => bytes.fill(0));
        }
      } finally {
        encryptedManifest.fill(0);
      }
    } finally {
      await hub.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
  60_000,
);
