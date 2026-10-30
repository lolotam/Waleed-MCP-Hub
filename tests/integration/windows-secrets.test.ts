import { tmpdir } from 'node:os';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  mkdir,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { windowsSecretStore, localRuntimeAdapters } from '@waleed/hub-core';

describe.skipIf(process.platform !== 'win32')(
  'real current-user DPAPI vault',
  () => {
    let directory: string,
      vault: Awaited<ReturnType<typeof windowsSecretStore>>;
    const id = 'wmh-secret-12345678-1234-1234-1234-123456789abc';
    const privateValue = Buffer.from(
      'SYNTHETIC-DPAPI-only-secret-عربي-0123456789',
    );
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'hub-dpapi-'));
      vault = await windowsSecretStore(join(directory, 'vault'));
    }, 30_000);
    afterAll(async () => {
      privateValue.fill(0);
      if (directory)
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 100,
        });
    });
    it('round-trips through CurrentUser protection without plaintext on disk, including a read-only launcher store', async () => {
      await vault.put(id, privateValue, AbortSignal.timeout(15_000));
      expect(await vault.has(id, AbortSignal.timeout(1000))).toBe(true);
      const disk = await readFile(join(directory, 'vault', `${id}.dpapi`));
      expect(disk.includes(privateValue)).toBe(false);
      expect(disk.includes(Buffer.from(privateValue.toString('base64')))).toBe(
        false,
      );
      const readOnly = await windowsSecretStore(join(directory, 'vault'), true);
      const value = await readOnly.read!(id, AbortSignal.timeout(15_000));
      try {
        expect(value.equals(privateValue)).toBe(true);
      } finally {
        value.fill(0);
      }
      await expect(
        readOnly.delete(id, AbortSignal.timeout(1000)),
      ).rejects.toBeDefined();
    }, 25_000);
    it('does not initialize or write a credential vault merely to construct dashboard runtime adapters', async () => {
      const root = join(directory, 'startup-only');
      await mkdir(root);
      const adapters = await localRuntimeAdapters(root, { PATH: '' });
      expect(adapters.secrets?.windows).toBeDefined();
      await expect(
        readFile(join(root, 'credentials', 'scope.json')),
      ).rejects.toHaveProperty('code', 'ENOENT');
    });
    it('atomically rotates protected OAuth bundles under a lock shared across vault instances, never writing plaintext', async () => {
      const accountId = `wmh-secret-${crypto.randomUUID()}`;
      const original = Buffer.from(
        JSON.stringify({
          accessToken: 'SYNTHETIC-ACCESS-OLD',
          refreshToken: 'SYNTHETIC-REFRESH-OLD',
        }),
      );
      const rotated = Buffer.from(
        JSON.stringify({
          accessToken: 'SYNTHETIC-ACCESS-NEW',
          refreshToken: 'SYNTHETIC-REFRESH-NEW',
        }),
      );
      const signal = AbortSignal.timeout(25_000);
      try {
        await vault.put(accountId, original, signal);
        const other = await windowsSecretStore(join(directory, 'vault'));
        const release = await vault.lock!(accountId, signal);
        const abort = new AbortController();
        const waiting = other.lock!(accountId, abort.signal);
        const rejected = expect(waiting).rejects.toBeDefined();
        abort.abort();
        await rejected;
        try {
          await vault.replace!(accountId, rotated, signal);
          const bytes = await other.read!(accountId, signal);
          try {
            expect(bytes.equals(rotated)).toBe(true);
          } finally {
            bytes.fill(0);
          }
        } finally {
          await release();
        }
        const reacquired = await other.lock!(accountId, signal);
        await reacquired();
        for (const name of await readdir(join(directory, 'vault'))) {
          const bytes = await readFile(join(directory, 'vault', name));
          try {
            for (const secret of [
              'SYNTHETIC-ACCESS-OLD',
              'SYNTHETIC-REFRESH-OLD',
              'SYNTHETIC-ACCESS-NEW',
              'SYNTHETIC-REFRESH-NEW',
            ])
              expect(bytes.includes(Buffer.from(secret))).toBe(false);
          } finally {
            bytes.fill(0);
          }
        }
        expect(
          (await readdir(join(directory, 'vault'))).some(
            (name) => name.endsWith('.pending') || name.endsWith('.lock'),
          ),
        ).toBe(false);
        const readOnly = await windowsSecretStore(
          join(directory, 'vault'),
          true,
        );
        await expect(
          readOnly.replace!(accountId, original, signal),
        ).rejects.toBeDefined();
        await expect(readOnly.lock!(accountId, signal)).rejects.toBeDefined();
        await vault.delete(accountId, signal);
      } finally {
        original.fill(0);
        rotated.fill(0);
      }
    }, 30_000);
    it('fails closed for a ciphertext copied to another vault scope and for tampering; never falls back to plaintext', async () => {
      const other = await windowsSecretStore(join(directory, 'other'));
      const disk = await readFile(join(directory, 'vault', `${id}.dpapi`));
      await writeFile(join(directory, 'other', `${id}.dpapi`), disk);
      await expect(
        other.read!(id, AbortSignal.timeout(15_000)),
      ).rejects.toBeDefined();
      disk[disk.length - 1] = disk[disk.length - 1]! ^ 1;
      await writeFile(join(directory, 'other', `${id}.dpapi`), disk);
      await expect(
        other.read!(id, AbortSignal.timeout(15_000)),
      ).rejects.toBeDefined();
      expect(await vault.has(id, AbortSignal.timeout(1000))).toBe(true);
    }, 30_000);
    it('rejects traversal/foreign identifiers, duplicate writes and junction roots', async () => {
      await expect(
        vault.read!('../outside', AbortSignal.timeout(1000)),
      ).rejects.toBeDefined();
      await expect(
        vault.put(id, privateValue, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: 'conflict' });
      await mkdir(join(directory, 'target'));
      await symlink(
        join(directory, 'target'),
        join(directory, 'linked'),
        'junction',
      );
      await expect(
        windowsSecretStore(join(directory, 'linked')),
      ).rejects.toBeDefined();
    });
    it('removes only the selected owned ciphertext', async () => {
      await vault.delete(id, AbortSignal.timeout(1000));
      expect(await vault.has(id, AbortSignal.timeout(1000))).toBe(false);
    });
  },
);
