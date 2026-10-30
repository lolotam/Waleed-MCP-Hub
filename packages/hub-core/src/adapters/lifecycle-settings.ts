import { join } from 'node:path';
import { readFile, open, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  LifecyclePreferencesSchema,
  type LifecyclePreferences,
} from '@waleed/contracts';
import {
  defaultLifecyclePreferences,
  type LifecyclePreferencesStore,
} from '../runtime/lifecycle-settings.js';
import { assertNoLinks } from './managed-files.js';
import { HubError } from '../errors.js';

// The Hub's existing writer lock owns this fixed, secret-free preferences file.
export function localLifecyclePreferences(
  directory: string,
): LifecyclePreferencesStore {
  const path = join(directory, 'lifecycle.json');
  const read = async () => {
    await assertNoLinks(directory);
    try {
      await assertNoLinks(path);
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096)
        throw new HubError('unavailable', 'Lifecycle settings are unsafe.');
      return LifecyclePreferencesSchema.parse(
        JSON.parse(await readFile(path, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return structuredClone(defaultLifecyclePreferences);
      throw error;
    }
  };
  return {
    read,
    async write(expectedRevision: number, next: LifecyclePreferences) {
      const current = await read();
      if (current.revision !== expectedRevision)
        throw new HubError('conflict', 'Lifecycle settings changed.');
      const temporary = join(directory, `lifecycle-${randomUUID()}.tmp`);
      let created = false;
      try {
        const file = await open(temporary, 'wx', 0o600);
        created = true;
        try {
          await file.writeFile(
            JSON.stringify(LifecyclePreferencesSchema.parse(next)),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await assertNoLinks(directory);
        await rename(temporary, path);
      } finally {
        if (created) await unlink(temporary).catch(() => undefined);
      }
    },
  };
}
