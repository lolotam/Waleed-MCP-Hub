import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { SafetyStateSchema } from '@waleed/contracts';
import { HubError } from '../errors.js';
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
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new HubError(
          'conflict',
          'Safety file cannot be a symbolic link.',
        );
      const file = await open(path, 'r');
      try {
        // Fixed-size reads bound memory even if an external writer grows the file.
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset > MAX_BYTES)
          throw new HubError(
            'invalid',
            'Safety file exceeds its supported size.',
          );
        return buffer.subarray(0, offset).toString('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
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
