import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  readdir,
  lstat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { StateSchema } from '@waleed/contracts';
import { HubError } from '../errors.js';
import { emptyState, type StateStore } from '../state.js';

const fingerprint = (raw: string) =>
  createHash('sha256').update(raw).digest('hex');
const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

// Holds a conservative lifetime lock. A crash leaves the lock for manual recovery;
// PID reuse must never let a second writer silently steal it.
export async function openStateStore(directory: string): Promise<StateStore> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new HubError(
      'invalid',
      'Runtime directory must not be a symbolic link.',
    );
  const lockPath = join(directory, 'writer.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new HubError(
      'busy',
      'Runtime is locked. Stop the other hub, or inspect the stale writer.lock before removing it.',
    );
  });
  let closed = false;
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    const statePath = join(directory, 'state.json');
    let raw: string | null = null;
    try {
      if ((await lstat(statePath)).isSymbolicLink())
        throw new HubError(
          'invalid',
          'State file must not be a symbolic link.',
        );
      raw = await readFile(statePath, 'utf8');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    let state =
      raw === null ? emptyState() : StateSchema.parse(JSON.parse(raw));
    let diskFingerprint = raw === null ? null : fingerprint(raw);
    let writing = false;

    async function assertUnchanged() {
      let current: string | null = null;
      try {
        if ((await lstat(statePath)).isSymbolicLink())
          throw new HubError(
            'conflict',
            'State was replaced by a symbolic link.',
          );
        current = fingerprint(await readFile(statePath, 'utf8'));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (current !== diskFingerprint)
        throw new HubError(
          'conflict',
          'State changed outside the hub. Restart and review it before trying again.',
        );
    }

    return {
      async read() {
        if (closed) throw new HubError('unavailable', 'State store is closed.');
        await assertUnchanged();
        return structuredClone(state);
      },
      async write(expectedRevision, next) {
        if (closed) throw new HubError('unavailable', 'State store is closed.');
        if (writing)
          throw new HubError(
            'busy',
            'Another state write is in progress. Retry with a fresh preview.',
          );
        writing = true;
        const tempPath = join(directory, `state-${randomUUID()}.tmp`);
        try {
          await assertUnchanged();
          if (
            state.revision !== expectedRevision ||
            next.revision !== expectedRevision + 1
          ) {
            throw new HubError(
              'conflict',
              'State revision changed. Create a fresh preview.',
            );
          }
          const validated = StateSchema.parse(next);
          const nextRaw = JSON.stringify(validated, null, 2) + '\n';
          if (raw !== null) {
            const backup = await open(
              join(
                directory,
                `backup-${String(state.revision).padStart(12, '0')}-${randomUUID()}.json`,
              ),
              'wx',
              0o600,
            );
            try {
              await backup.writeFile(raw);
              await backup.sync();
            } finally {
              await backup.close();
            }
          }
          const file = await open(tempPath, 'wx', 0o600);
          try {
            await file.writeFile(nextRaw);
            await file.sync();
          } finally {
            await file.close();
          }
          await assertUnchanged();
          for (let attempt = 0; ; attempt++) {
            try {
              await rename(tempPath, statePath);
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
              await assertUnchanged();
            }
          }
          // Once rename succeeds, the commit is authoritative even if retention fails.
          raw = nextRaw;
          diskFingerprint = fingerprint(nextRaw);
          state = validated;
          const backups = (await readdir(directory).catch(() => [] as string[]))
            .filter((name) => /^backup-\d{12}-[a-f0-9-]+\.json$/.test(name))
            .sort();
          for (const name of backups.slice(0, -5))
            await unlink(join(directory, name)).catch(() => undefined);
        } finally {
          writing = false;
          await unlink(tempPath).catch(() => undefined);
        }
      },
      async close() {
        if (closed) return;
        if (writing)
          throw new HubError(
            'busy',
            'Wait for the active write before closing the state store.',
          );
        closed = true;
        await lock.close();
        await unlink(lockPath);
      },
    };
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
}
