import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BootRecordSchema, InstallRecordSchema } from '@waleed/contracts';
import { assertNoLinks } from '../adapters/managed-files.js';
import { HubError } from '../errors.js';
import { readOwnedFile } from '../packages/store.js';

export interface BootRecord {
  bootId: string;
  startedAt: number;
}
export interface InstallRecord {
  installId: string;
  createdAt: number;
}

const BOOT_FILE = 'boot.json';
const INSTALL_FILE = 'install.json';
const MAX_RECORD_BYTES = 4096;
const bootUnavailable = () =>
  new HubError('unavailable', 'The boot record is missing or unreadable.');
const installUnavailable = () =>
  new HubError('unavailable', 'The install record is missing or unreadable.');
const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

type RecordSchema<T> = { parse(value: unknown): T };

// The protected read: a link, a hard link, a folder, an oversized file or a
// malformed record is refused, never repaired.
async function readRecord<T>(
  path: string,
  schema: RecordSchema<T>,
  failure: () => HubError,
): Promise<T> {
  let bytes: Buffer | null;
  try {
    await assertNoLinks(path, true);
    bytes = await readOwnedFile(path, MAX_RECORD_BYTES);
  } catch {
    throw failure();
  }
  if (!bytes) throw failure();
  try {
    return schema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw failure();
  } finally {
    bytes.fill(0);
  }
}

// The boot record names one hub generation. It is written atomically: a
// temporary file in the same folder is renamed over the record, so a reader
// never sees a partial file and a link in place of it is never overwritten.
export async function writeBootRecord(
  directory: string,
  now: () => number = Date.now,
): Promise<BootRecord> {
  const record = BootRecordSchema.parse({
    bootId: randomUUID(),
    startedAt: now(),
  });
  const root = resolve(directory);
  const path = join(root, BOOT_FILE);
  const temporary = join(root, `.wmh-boot-${randomUUID()}.tmp`);
  // A link in place of the record is refused: the rename never overwrites it.
  await assertNoLinks(path, true);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(record, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (
          attempt >= 4 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? '')
        )
          throw error;
        await setTimeout(25 * (attempt + 1));
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return record;
}

// The install record names one installation: it is created once and never
// rewritten, so every later start reads the same identifier.
export async function ensureInstallRecord(
  directory: string,
  now: () => number = Date.now,
): Promise<InstallRecord> {
  const path = join(resolve(directory), INSTALL_FILE);
  const record = InstallRecordSchema.parse({
    installId: randomUUID(),
    createdAt: now(),
  });
  const file = await open(path, 'wx', 0o600).catch((error: unknown) => {
    if (code(error) !== 'EEXIST') throw error;
    return null;
  });
  if (!file) {
    // Another hub won the race: its record is the one that counts.
    return readCompletedInstallRecord(directory);
  }
  try {
    await file.writeFile(JSON.stringify(record, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  return record;
}

// The winner of the exclusive create may still be writing its record: it is
// read again until it parses.
async function readCompletedInstallRecord(
  directory: string,
): Promise<InstallRecord> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      return await readInstallRecord(directory);
    } catch (error) {
      if (attempt === 24) throw error;
      await setTimeout(20);
    }
  }
  throw installUnavailable();
}

export async function readBootRecord(directory: string): Promise<BootRecord> {
  return readRecord(
    join(resolve(directory), BOOT_FILE),
    BootRecordSchema,
    bootUnavailable,
  );
}

export async function readInstallRecord(
  directory: string,
): Promise<InstallRecord> {
  return readRecord(
    join(resolve(directory), INSTALL_FILE),
    InstallRecordSchema,
    installUnavailable,
  );
}
