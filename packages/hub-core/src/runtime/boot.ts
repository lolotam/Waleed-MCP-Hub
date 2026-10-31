import { randomUUID } from 'node:crypto';
import { link, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
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
// The temporary file a hub writes before the install record exists.
const INSTALL_TEMPORARY = /^\.wmh-install-[0-9a-f-]{36}\.tmp$/;
// A temporary install record this old belongs to a hub that stopped while it
// was creating the record.
const STALE_INSTALL_TEMPORARY_MS = 60_000;
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

// A temporary install record left by a hub that stopped while creating the
// record. One that already is the record (the same file under a second name)
// or is old enough is removed, so the record is a single link again.
async function removeStaleInstallTemporaries(root: string) {
  const names = await readdir(root).catch(() => [] as string[]);
  const record = await lstat(join(root, INSTALL_FILE), { bigint: true }).catch(
    () => null,
  );
  for (const name of names) {
    if (!INSTALL_TEMPORARY.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path, { bigint: true }).catch(() => null);
    if (!info || !info.isFile()) continue;
    const linked =
      record !== null && record.ino === info.ino && record.dev === info.dev;
    const stale =
      Date.now() - Number(info.mtimeMs) > STALE_INSTALL_TEMPORARY_MS;
    if (linked || stale) await removeTemporary(path);
  }
}

// Removes a temporary name, retrying a name the system still holds for a
// moment. A name that is already gone counts as removed. Whether it is gone.
async function removeTemporary(path: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (code(error) === 'ENOENT') return true;
      if (
        attempt >= 4 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? '')
      )
        return false;
      await setTimeout(25 * (attempt + 1));
    }
  }
}

// The creations of one folder in this process run one after another, so a
// creator that pauses never loses its temporary file to another one. Two
// hubs never share a folder: the writer lock keeps the second one out.
const installCreations = new Map<string, Promise<unknown>>();

// The install record names one installation: it is created once and never
// rewritten, so every later start reads the same identifier. It is written
// to a temporary file first and then linked into place: a link never
// replaces an existing record, and a hub that stops halfway leaves at most a
// temporary file, never a partial record.
export async function ensureInstallRecord(
  directory: string,
  now: () => number = Date.now,
): Promise<InstallRecord> {
  const root = resolve(directory);
  const key = root.toLowerCase();
  const current = (installCreations.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => createInstallRecord(root, now));
  installCreations.set(key, current);
  try {
    return await current;
  } finally {
    if (installCreations.get(key) === current) installCreations.delete(key);
  }
}

async function createInstallRecord(
  root: string,
  now: () => number,
): Promise<InstallRecord> {
  const path = join(root, INSTALL_FILE);
  await removeStaleInstallTemporaries(root);
  const record = InstallRecordSchema.parse({
    installId: randomUUID(),
    createdAt: now(),
  });
  const temporary = join(root, `.wmh-install-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(record, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  let linked = false;
  try {
    await link(temporary, path);
    linked = true;
  } catch (error) {
    if (code(error) !== 'EEXIST') {
      await removeTemporary(temporary);
      throw error;
    }
  }
  // A record that keeps its temporary second name is refused by every
  // reader, so the creation fails instead of returning it; the next start
  // removes the name.
  if (!(await removeTemporary(temporary)) && linked) throw installUnavailable();
  // The record that counts is the one on disk: this one, or the one of the
  // hub that won the race. It is returned only once it reads back.
  const stored = await readCompletedInstallRecord(root);
  if (linked && stored.installId !== record.installId)
    throw installUnavailable();
  return stored;
}

// The record of the winner may still carry its temporary second name for a
// moment: it is read again until it is a single complete file.
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
