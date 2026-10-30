import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { HubState } from '@waleed/contracts';
import { HubError } from '../errors.js';
import { assertNoLinks } from '../adapters/managed-files.js';
import { restrictPrivatePath } from '../integrations/files.js';

// The managed package layout is spelled out here and nowhere else: the store,
// the installer and the registry all build the same paths from it. An install
// folder is `<packages>\<installId>`, the transaction marker is the sibling
// file `<packages>\<installId>.installing` and job folders live in
// `<packages>\.jobs\<jobId>`.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER_SUFFIX = '.installing';
const JOBS_FOLDER = '.jobs';
const invalid = (message: string) => new HubError('invalid', message);
// Identifiers reach the filesystem as path segments, so only a UUID is ever
// accepted; nothing else can escape the packages folder.
const assertId = (id: string): string => {
  if (!UUID.test(id)) throw invalid('A package identifier must be a UUID.');
  return id;
};
const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

export const packagesRoot = (dataDirectory: string): string =>
  join(dataDirectory, 'packages');
export const installDirectory = (
  packagesDir: string,
  installId: string,
): string => join(packagesDir, assertId(installId));
export const markerPath = (packagesDir: string, installId: string): string =>
  join(packagesDir, `${assertId(installId)}${MARKER_SUFFIX}`);
export const jobDirectory = (packagesDir: string, jobId: string): string =>
  join(packagesDir, JOBS_FOLDER, assertId(jobId));

// Every folder the hub owns is created private to the current user.
export async function createPrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await restrictPrivatePath(path);
}

// The marker holds the job id and nothing else: it says which install owns the
// folder while the install runs, and never anything about the package.
export async function writeMarker(
  packagesDir: string,
  installId: string,
  jobId: string,
): Promise<void> {
  const path = markerPath(packagesDir, installId);
  assertId(jobId);
  const temporary = join(packagesDir, `.wmh-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(jobId);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
// Reads a regular file the hub owns through one handle: the checks and the
// read see the same file, so nothing can swap it in between. A link, a
// hard-linked file, a file over the cap or one that grows while it is read is
// refused.
export async function readOwnedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    // A folder or a link that cannot be followed is not a regular file: it
    // is refused, not an error.
    const reason = code(error);
    if (reason === 'ENOENT' || reason === 'EISDIR' || reason === 'ELOOP')
      return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) return null;
    // The path must still name the file the handle points to: a link that
    // took its place in the meantime is refused, even though the handle
    // followed it.
    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink()) return null;
    if (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) return null;
    // The read never asks for more than one byte beyond the cap, so a file
    // that grew while it was read is refused instead of being cut short.
    const chunks: Buffer[] = [];
    let size = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    while (size <= maxBytes) {
      const wanted = Math.min(chunk.length, maxBytes + 1 - size);
      const { bytesRead } = await handle.read(chunk, 0, wanted, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    if (size > maxBytes) return null;
    return Buffer.concat(chunks);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  } finally {
    await handle.close();
  }
}
export async function readMarker(
  packagesDir: string,
  installId: string,
): Promise<string | null> {
  const bytes = await readOwnedFile(markerPath(packagesDir, installId), 4096);
  if (!bytes) return null;
  const jobId = bytes.toString('utf8').trim();
  return UUID.test(jobId) ? jobId : null;
}
export async function removeMarker(
  packagesDir: string,
  installId: string,
): Promise<void> {
  try {
    await unlink(markerPath(packagesDir, installId));
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
}

const busy = (error: unknown): boolean => {
  const value = code(error);
  return value === 'EBUSY' || value === 'EPERM' || value === 'EACCES';
};
// A link entry is removed as an entry: the target of a junction or a symbolic
// link is never touched.
async function removeEntry(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return true;
    if (!busy(error) && code(error) !== 'EISDIR') throw error;
  }
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return true;
    if (busy(error) || code(error) === 'ENOTDIR' || code(error) === 'ENOTEMPTY')
      return false;
    throw error;
  }
}
async function removeEntryTree(path: string): Promise<boolean> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (code(error) === 'ENOENT') return true;
    throw error;
  }
  if (info.isSymbolicLink()) return removeEntry(path);
  if (info.isDirectory()) {
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      if (code(error) === 'ENOENT') return true;
      throw error;
    }
    for (const entry of names)
      if (!(await removeEntryTree(join(path, entry)))) return false;
    try {
      await rmdir(path);
    } catch (error) {
      if (code(error) === 'ENOENT') return true;
      if (busy(error)) return false;
      throw error;
    }
    return true;
  }
  return removeEntry(path);
}
// The guarded delete: only a path strictly inside the packages folder is ever
// removed, links are never followed and a file that is in use is reported so
// the caller can retry later instead of blocking.
export async function removeTree(
  path: string,
  packagesDir: string,
): Promise<boolean> {
  const root = resolve(packagesDir);
  const target = resolve(path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.toLowerCase().startsWith(prefix.toLowerCase()))
    throw invalid('The path is outside the packages folder.');
  await assertNoLinks(root, true);
  return removeEntryTree(target);
}

// The hub-wide package lock: one install, one replace or one reconciliation
// at a time, in the order the callers asked for it.
export interface PackageLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
export function createPackageLock(): PackageLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export interface ReconcileOptions {
  packagesDir: string;
  readState: () => Promise<HubState>;
  activeJobs: () => ReadonlySet<string>;
  lock: PackageLock;
}
export interface ReconcileResult {
  deleted: string[];
  retained: string[];
}
const lstatOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  }
};
// Reconciliation removes what no connector owns any more: install folders, the
// markers of finished jobs and the folders of finished jobs. It never touches a
// referenced folder and never touches a name the hub does not own.
export async function reconcilePackages(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  return options.lock.run(async () => {
    // The registry is read inside the lock: a publish and save that ran before
    // this section is already visible here, so its folder is never deleted.
    const state = await options.readState();
    const referenced = new Set<string>();
    for (const connector of state.connectors)
      if (connector.executionMode === 'native' && connector.package)
        referenced.add(connector.package.installId);
    const active = options.activeJobs();
    // A lookup that starts during the pass must not lose its folder while npm
    // runs in it: the live jobs are read again before every deletion that
    // depends on a job id.
    const isActive = (jobId: string): boolean =>
      options.activeJobs().has(jobId);
    const deleted = new Set<string>();
    const retained = new Set<string>();
    let entries: Dirent[];
    try {
      entries = await readdir(options.packagesDir, { withFileTypes: true });
    } catch (error) {
      if (code(error) === 'ENOENT')
        return { deleted: [...deleted], retained: [...retained] };
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(MARKER_SUFFIX)) continue;
      const installId = entry.name.slice(0, -MARKER_SUFFIX.length);
      if (!UUID.test(installId)) continue;
      // Removing a marker publishes a folder, so a referenced folder keeps its
      // marker and keeps failing verification until it is reinstalled.
      if (referenced.has(installId)) continue;
      const jobId = await readMarker(options.packagesDir, installId);
      if (jobId && active.has(jobId)) continue;
      await removeMarker(options.packagesDir, installId);
    }
    for (const entry of entries) {
      if (!UUID.test(entry.name)) continue;
      const folder = join(options.packagesDir, entry.name);
      const info = await lstatOrNull(folder);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
      if (referenced.has(entry.name)) {
        retained.add(entry.name);
        continue;
      }
      const jobId = await readMarker(options.packagesDir, entry.name);
      if (jobId && isActive(jobId)) {
        retained.add(entry.name);
        continue;
      }
      if (await removeTree(folder, options.packagesDir))
        deleted.add(entry.name);
      else retained.add(entry.name);
    }
    let jobEntries: Dirent[] = [];
    try {
      jobEntries = await readdir(join(options.packagesDir, JOBS_FOLDER), {
        withFileTypes: true,
      });
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
    for (const entry of jobEntries) {
      if (!UUID.test(entry.name)) continue;
      const folder = join(options.packagesDir, JOBS_FOLDER, entry.name);
      const info = await lstatOrNull(folder);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
      if (isActive(entry.name)) continue;
      if (await removeTree(folder, options.packagesDir))
        deleted.add(entry.name);
      else retained.add(entry.name);
    }
    return { deleted: [...deleted], retained: [...retained] };
  });
}
