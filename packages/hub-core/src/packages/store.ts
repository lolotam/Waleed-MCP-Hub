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
import { dirname, join, resolve, sep } from 'node:path';
import type { HubState } from '@waleed/contracts';
import { HubError } from '../errors.js';
import { assertNoLinks, checkedReadFlags } from '../adapters/managed-files.js';
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
  // Only a path that does not exist is reported as missing (null). Anything
  // else that is refused (a folder, a link, a hard link, an oversized file,
  // a file that changed or vanished) is an error: callers such as
  // reconciliation read "missing" as "no live job owns this marker".
  const refused = () =>
    new HubError('conflict', 'Owned file changed or is unsafe.');
  let handle: FileHandle;
  try {
    handle = await open(path, checkedReadFlags);
  } catch (error) {
    const reason = code(error);
    if (reason === 'ENOENT') {
      // A link whose target is missing also opens as ENOENT on Windows: the
      // path is missing only when no existing part of it is a link.
      await assertNoLinks(path, true);
      return null;
    }
    if (reason === 'EISDIR' || reason === 'ELOOP') throw refused();
    throw error;
  }
  try {
    // File ids are compared as exact integers: a Windows file id does not fit
    // in a JavaScript number, so two different files could look equal.
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(maxBytes))
      throw refused();
    // The path must still name the file the handle points to: a link that
    // took its place in the meantime is refused, even though the handle
    // followed it.
    // No part of the path may have become a link since the open.
    await assertNoLinks(path);
    const pathInfo = await lstat(path, { bigint: true });
    if (
      pathInfo.isSymbolicLink() ||
      pathInfo.dev !== info.dev ||
      pathInfo.ino !== info.ino
    )
      throw refused();
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
    if (size > maxBytes) throw refused();
    return Buffer.concat(chunks);
  } catch (error) {
    // The file existed when it was opened: one that vanished from its path
    // since then is refused, never reported as missing.
    if (code(error) === 'ENOENT') throw refused();
    throw error;
  } finally {
    await handle.close();
  }
}
// A refused owned file shares the fault code of a missing one; any other
// read failure is rethrown unchanged.
export const refusedAsMissing = (error: unknown): null => {
  if (error instanceof HubError && error.code === 'conflict') return null;
  throw error;
};
export async function readMarker(
  packagesDir: string,
  installId: string,
): Promise<string | null> {
  const bytes = await readOwnedFile(markerPath(packagesDir, installId), 4096);
  if (!bytes) return null;
  const jobId = bytes.toString('utf8').trim();
  // A marker is written whole (a temporary file renamed into place), so one
  // that exists without a job id was not written by the hub: it is refused,
  // never read as "no job".
  if (!UUID.test(jobId))
    throw new HubError('conflict', 'Owned file changed or is unsafe.');
  return jobId;
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
      // An entry created after the listing: the tree is kept for a later pass.
      if (busy(error) || code(error) === 'ENOTEMPTY') return false;
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
  // A folder between the packages folder and the entry (such as the jobs
  // folder) that is a link is refused as well.
  await assertNoLinks(dirname(target), true);
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
    // A lookup that starts during the pass must not lose its folder while npm
    // runs in it: the live jobs are read again before every deletion that
    // depends on a job id.
    const isActive = (jobId: string): boolean =>
      options.activeJobs().has(jobId);
    const deleted = new Set<string>();
    const retained = new Set<string>();
    // The pass works from one listing of the packages folder. The folder is
    // identified before the listing and checked again before every removal:
    // a folder that was replaced or turned into a link ends the pass, so
    // nothing is removed from a tree the listing did not come from.
    const refused = () =>
      new HubError('conflict', 'Owned file changed or is unsafe.');
    const folderId = async (path: string): Promise<string> => {
      await assertNoLinks(path);
      const info = await lstat(path, { bigint: true });
      if (!info.isDirectory()) throw refused();
      return `${info.dev}:${info.ino}`;
    };
    const sameFolder = async (path: string, id: string): Promise<void> => {
      let now: string;
      try {
        now = await folderId(path);
      } catch {
        now = '';
      }
      if (now !== id) throw refused();
    };
    // Only a packages folder that is missing before the pass starts means
    // there is nothing to reconcile. Once it has been identified, any failure
    // to list it is a conflict.
    let root: string;
    try {
      root = await folderId(options.packagesDir);
    } catch (error) {
      if (code(error) === 'ENOENT')
        return { deleted: [...deleted], retained: [...retained] };
      throw error;
    }
    const assertRoot = () => sameFolder(options.packagesDir, root);
    let entries: Dirent[];
    try {
      entries = await readdir(options.packagesDir, { withFileTypes: true });
    } catch (error) {
      await assertRoot();
      if (code(error) === 'ENOENT') throw refused();
      throw error;
    }
    // A marker that exists but is refused (a link, a hard link, a folder, an
    // oversized or malformed file, one that changed while read) keeps its
    // marker and its folder for this pass; the other entries are still
    // reconciled.
    const refusedIds = new Set<string>();
    const markerOf = async (installId: string) => {
      try {
        return { jobId: await readMarker(options.packagesDir, installId) };
      } catch (error) {
        if (error instanceof HubError && error.code === 'conflict') {
          // A refusal caused by the packages folder itself ends the pass.
          await assertRoot();
          refusedIds.add(installId);
          return null;
        }
        throw error;
      }
    };
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(MARKER_SUFFIX)) continue;
      const installId = entry.name.slice(0, -MARKER_SUFFIX.length);
      if (!UUID.test(installId)) continue;
      // Removing a marker publishes a folder, so a referenced folder keeps its
      // marker and keeps failing verification until it is reinstalled.
      if (referenced.has(installId)) continue;
      const marker = await markerOf(installId);
      if (!marker) continue;
      if (marker.jobId && isActive(marker.jobId)) continue;
      await assertRoot();
      await removeMarker(options.packagesDir, installId);
    }
    for (const entry of entries) {
      if (!UUID.test(entry.name)) continue;
      const folder = join(options.packagesDir, entry.name);
      const info = await lstatOrNull(folder);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
      if (referenced.has(entry.name) || refusedIds.has(entry.name)) {
        retained.add(entry.name);
        continue;
      }
      const marker = await markerOf(entry.name);
      if (!marker || (marker.jobId && isActive(marker.jobId))) {
        retained.add(entry.name);
        continue;
      }
      await assertRoot();
      if (await removeTree(folder, options.packagesDir))
        deleted.add(entry.name);
      else retained.add(entry.name);
    }
    // The jobs folder gets the same treatment as the packages folder: a
    // link is refused, and its identity is checked before every removal.
    const jobsDir = join(options.packagesDir, JOBS_FOLDER);
    await assertRoot();
    let jobs: string | null;
    try {
      jobs = await folderId(jobsDir);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      await assertRoot();
      jobs = null;
    }
    let jobEntries: Dirent[] = [];
    if (jobs !== null) {
      const jobsId = jobs;
      try {
        jobEntries = await readdir(jobsDir, { withFileTypes: true });
      } catch (error) {
        await assertRoot();
        await sameFolder(jobsDir, jobsId);
        if (code(error) === 'ENOENT') throw refused();
        throw error;
      }
    }
    const assertTrees = async (): Promise<void> => {
      await assertRoot();
      if (jobs !== null) await sameFolder(jobsDir, jobs);
    };
    for (const entry of jobEntries) {
      if (!UUID.test(entry.name)) continue;
      const folder = join(jobsDir, entry.name);
      const info = await lstatOrNull(folder);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
      if (isActive(entry.name)) continue;
      await assertTrees();
      if (await removeTree(folder, options.packagesDir))
        deleted.add(entry.name);
      else retained.add(entry.name);
    }
    // An entry that is gone because a folder was replaced is skipped above
    // as missing, so the pass reports success only when both folders are
    // still the ones it listed. Every removal was checked before it ran.
    await assertTrees();
    return { deleted: [...deleted], retained: [...retained] };
  });
}
