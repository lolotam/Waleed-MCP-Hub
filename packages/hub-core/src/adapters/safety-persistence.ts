import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { SafetyStateSchema } from '@waleed/contracts';
import { HubError } from '../errors.js';
import { readOwnedFile } from './managed-files.js';
import { createSafetyLedger, emptySafetyState } from '../safety.js';

const MAX_BYTES = 512 * 1024;
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function openSafetyLedger(
  directory: string,
  now: () => number = Date.now,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new HubError(
      'invalid',
      'Safety directory must not be a symbolic link.',
    );
  const lockPath = join(directory, 'safety.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new HubError(
      'busy',
      'Safety ledger is locked. Inspect its owner before removing a stale lock.',
    );
  });
  const path = join(directory, 'safety.json');
  let fingerprint: string | null = null;
  async function load(): Promise<string | null> {
    // Checked and read through one handle: a link, a hard link or a file
    // that is or grows over the cap is refused, and nothing can swap the
    // file between the check and the read.
    try {
      const bytes = await readOwnedFile(path, MAX_BYTES);
      return bytes === null ? null : bytes.toString('utf8');
    } catch (error) {
      if (error instanceof HubError && error.code === 'conflict')
        throw new HubError(
          'conflict',
          'Safety file must be a regular file within its supported size.',
        );
      throw error;
    }
  }
  async function assertUnchanged() {
    const raw = await load();
    if ((raw === null ? null : digest(raw)) !== fingerprint)
      throw new HubError(
        'conflict',
        'Safety metadata changed outside the manager. Restart and review recovery.',
      );
  }
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(now()).toISOString(),
      }),
    );
    const raw = await load();
    let state = emptySafetyState();
    if (raw !== null) {
      try {
        state = SafetyStateSchema.parse(JSON.parse(raw));
      } catch {
        throw new HubError(
          'invalid',
          'Safety metadata is corrupt or uses an unsupported version.',
        );
      }
      fingerprint = digest(raw);
    }
    return createSafetyLedger(
      state,
      {
        assertUnchanged,
        async save(next) {
          const checked = SafetyStateSchema.safeParse(next);
          if (!checked.success)
            throw new HubError('invalid', 'Invalid safety metadata.');
          const content = JSON.stringify(checked.data) + '\n';
          if (Buffer.byteLength(content) > MAX_BYTES)
            throw new HubError('invalid', 'Safety metadata exceeds its limit.');
          const temporary = join(directory, `safety-${randomUUID()}.tmp`);
          try {
            await assertUnchanged();
            const file = await open(temporary, 'wx', 0o600);
            try {
              await file.writeFile(content);
              await file.sync();
            } finally {
              await file.close();
            }
            for (let attempt = 0; ; attempt++) {
              await assertUnchanged();
              try {
                await rename(temporary, path);
                break;
              } catch (error) {
                if (
                  attempt >= 4 ||
                  !['EPERM', 'EACCES', 'EBUSY'].includes(
                    (error as NodeJS.ErrnoException).code ?? '',
                  )
                )
                  throw error;
                await setTimeout(25 * (attempt + 1));
              }
            }
            // Nothing after this assignment may turn a committed save into failure.
            fingerprint = digest(content);
          } finally {
            await unlink(temporary).catch(() => undefined);
          }
        },
        async close() {
          await lock.close();
          await unlink(lockPath);
        },
      },
      now,
    );
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
}
