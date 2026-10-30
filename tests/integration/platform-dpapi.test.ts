import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  windowsSecretStore,
  createPlatformCredentialStorage,
} from '@waleed/hub-core';

it.skipIf(process.platform !== 'win32')(
  'the platform factory opens existing DPAPI scope/ciphertext byte-for-byte without migration or re-encryption',
  async () => {
    const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\platform-dpapi-'),
      id = `wmh-secret-${randomUUID()}`,
      value = Buffer.from('SYNTHETIC-LEGACY-DPAPI');
    try {
      const legacy = await windowsSecretStore(directory);
      await legacy.put(id, value, AbortSignal.timeout(15000));
      const beforeScope = await readFile(join(directory, 'scope.json')),
        beforeCipher = await readFile(join(directory, `${id}.dpapi`));
      const platform = createPlatformCredentialStorage({ directory });
      expect(platform.status()).toMatchObject({
        backend: 'dpapi',
        state: 'not_checked',
      });
      const bytes = await platform.backends.windows!.read!(
        id,
        AbortSignal.timeout(15000),
      );
      try {
        expect(bytes).toEqual(value);
      } finally {
        bytes.fill(0);
      }
      expect(await readFile(join(directory, 'scope.json'))).toEqual(
        beforeScope,
      );
      expect(await readFile(join(directory, `${id}.dpapi`))).toEqual(
        beforeCipher,
      );
      expect(await readdir(directory)).not.toContain('keyring-scope.json');
      expect(platform.status()).toMatchObject({
        backend: 'dpapi',
        state: 'available',
        containment: 'windows-job-object',
      });
    } finally {
      value.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
