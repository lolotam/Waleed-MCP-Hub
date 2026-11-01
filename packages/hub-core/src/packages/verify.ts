import { createHash } from 'node:crypto';
import { createReadStream, type BigIntStats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import type { Connector } from '@waleed/contracts';
import { assertNoLinks, checkedReadFlags } from '../adapters/managed-files.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import {
  NO_GLOBAL_SEARCH_PATHS,
  isPackageEnvName,
  packagesDirOf,
} from '../runtime/registry.js';
// The cap of the frozen lock. The lookup, the install and the verification
// share it: a lock the install accepted is never "modified" at the next
// launch.
import { MAX_LOCK_BYTES } from './resolve.js';
import { installDirectory, markerPath, readOwnedFile } from './store.js';

// Every failure here is a closed failure with a sanitized reason: no path, no
// file name and no content ever reaches the caller.
const modified = () => new RuntimeFault('package_modified');
const MAX_FILES = 50_000;
const MAX_BYTES = 500 * 1024 * 1024;

export interface PackageManifest {
  hash: string;
  files: number;
  bytes: number;
}
const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
};
// An aborted verification is a cancellation, never a modified package: the
// walk stops and the open hash stream is destroyed.
const cancelled = () => new RuntimeFault('cancelled');
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelled();
};
interface InstalledDirectory {
  path: string;
  identity: BigIntStats;
}
interface InstalledFile {
  path: string;
  relative: string;
  size: number;
  identity: BigIntStats;
}
const sameFile = (left: BigIntStats, right: BigIntStats) =>
  right.isFile() &&
  right.nlink === 1n &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
async function digest(
  file: InstalledFile,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const handle = await open(file.path, checkedReadFlags);
  let stream: ReturnType<typeof createReadStream> | undefined;
  let closed: Promise<void> | undefined;
  const onAbort = () => stream?.destroy(cancelled());
  try {
    if (!sameFile(file.identity, await handle.stat({ bigint: true })))
      throw modified();
    throwIfAborted(signal);
    const hash = createHash('sha256');
    // Hash the verified handle, never reopen the path after its identity check.
    // A small file gets a small read buffer: most installed files are a few KiB,
    // and a fixed 64 KiB buffer per file dominated the verification time.
    stream = createReadStream(file.path, {
      fd: handle,
      autoClose: false,
      highWaterMark: Math.min(Math.max(file.size, 1), 64 * 1024),
    });
    closed = new Promise<void>((resolve) => stream!.once('close', resolve));
    // Cancellation may arrive between iterator reads or during final checks.
    // The iterator still observes read errors; keep late destruction handled.
    stream.on('error', () => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    throwIfAborted(signal);
    for await (const chunk of stream) hash.update(chunk);
    throwIfAborted(signal);
    if (
      !sameFile(file.identity, await handle.stat({ bigint: true })) ||
      !sameFile(file.identity, await lstat(file.path, { bigint: true }))
    )
      throw modified();
    return hash.digest('hex');
  } catch (error) {
    throw signal?.aborted ? cancelled() : error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    stream?.destroy();
    await closed;
    await handle.close();
  }
}
// Up to this many files are hashed at once. One at a time left a seven-peer
// catalog waiting about 5 s per 13k-file install.
const HASH_CONCURRENCY = 8;

// Lists every installed file. A link, a hardlinked file or anything that is not
// a plain file or folder fails the walk, and the caps are checked for the whole
// tree before any file is read.
async function listInstalledFiles(
  installDir: string,
  signal?: AbortSignal,
): Promise<{
  files: InstalledFile[];
  directories: InstalledDirectory[];
  bytes: number;
}> {
  const files: InstalledFile[] = [];
  const directories: InstalledDirectory[] = [];
  let bytes = 0,
    entries = 0;
  // Include directories in the admission cap and stream directory entries so a
  // single wide directory cannot enqueue an unbounded number of stat calls.
  const pending = [{ path: installDir, prefix: '' }];
  while (pending.length) {
    throwIfAborted(signal);
    const directory = pending.pop()!;
    const identity = await lstat(directory.path, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw modified();
    directories.push({ path: directory.path, identity });
    const listing = await opendir(directory.path);
    for await (const entry of listing) {
      throwIfAborted(signal);
      if (++entries > MAX_FILES) throw modified();
      const path = join(directory.path, entry.name);
      const relative = directory.prefix
        ? `${directory.prefix}/${entry.name}`
        : entry.name;
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) throw modified();
      if (info.isDirectory()) {
        pending.push({ path, prefix: relative });
        continue;
      }
      if (!info.isFile() || info.nlink !== 1n) throw modified();
      bytes += Number(info.size);
      if (bytes > MAX_BYTES) throw modified();
      files.push({ path, relative, size: Number(info.size), identity: info });
    }
  }
  return { files, directories, bytes };
}

// Every file is hashed even when a worker fails, so no stream outlives the
// call; the first failure is then reported.
async function manifestLines(
  files: InstalledFile[],
  signal?: AbortSignal,
): Promise<string[]> {
  const lines = new Array<string>(files.length);
  let next = 0,
    failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < files.length) {
      const index = next++;
      const file = files[index]!;
      try {
        throwIfAborted(signal);
        lines[index] =
          `${file.relative}\0${file.size}\0${await digest(file, signal)}`;
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: HASH_CONCURRENCY }, worker));
  if (failure) throw failure.error;
  throwIfAborted(signal);
  return lines;
}

// The installed-file manifest: one line per regular file, sorted, hashed
// together.
export async function buildManifest(
  installDir: string,
  signal?: AbortSignal,
): Promise<PackageManifest> {
  const root = await lstat(installDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw modified();
  const { files, directories, bytes } = await listInstalledFiles(
    installDir,
    signal,
  );
  const lines = await manifestLines(files, signal);
  // Directory names must still refer to the tree we walked, including paths
  // that might otherwise have been replaced with links while files were read.
  for (const directory of directories) {
    throwIfAborted(signal);
    const named = await lstat(directory.path, { bigint: true });
    const before = directory.identity;
    if (
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.mtimeNs !== before.mtimeNs ||
      named.ctimeNs !== before.ctimeNs
    )
      throw modified();
  }
  // The last stat may have completed after the caller gave up.
  throwIfAborted(signal);
  lines.sort();
  return {
    hash: createHash('sha256').update(lines.join('\n')).digest('hex'),
    files: lines.length,
    bytes,
  };
}
const samePath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

// The launch verification of a managed connector. It never starts a process
// and it never resolves a secret: it only decides whether the install folder
// is still the one the hub approved.
export async function verifyPackageFiles(
  connector: Connector,
  packagesDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (connector.executionMode !== 'native' || !connector.package) return;
  const pkg = connector.package;
  // An aborted operation never touches a file.
  throwIfAborted(signal);
  if (connector.arguments[0] !== NO_GLOBAL_SEARCH_PATHS) throw modified();
  const derived = packagesDirOf(connector.arguments[1] ?? '', pkg);
  if (!derived || !samePath(derived, packagesDir)) throw modified();
  for (const key of [
    ...Object.keys(connector.environmentLiterals ?? {}),
    ...Object.keys(connector.secretBindings),
  ])
    if (isPackageEnvName(key)) throw new RuntimeFault('invalid_configuration');
  try {
    const installDir = installDirectory(packagesDir, pkg.installId);
    await assertNoLinks(installDir);
    const info = await lstat(installDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw modified();
    if (await exists(markerPath(packagesDir, pkg.installId))) throw modified();
    const lockPath = join(installDir, 'package-lock.json');
    const bytes = await readOwnedFile(lockPath, MAX_LOCK_BYTES);
    if (!bytes) throw modified();
    try {
      if (createHash('sha256').update(bytes).digest('hex') !== pkg.lockHash)
        throw modified();
    } finally {
      bytes.fill(0);
    }
    if ((await buildManifest(installDir, signal)).hash !== pkg.manifestHash)
      throw modified();
    // Node resolves bare imports by walking up the parent folders, so no parent
    // of the install may hold a node_modules entry.
    let parent = resolve(packagesDir);
    for (;;) {
      throwIfAborted(signal);
      if (await exists(join(parent, 'node_modules'))) throw modified();
      const up = dirname(parent);
      if (up === parent) break;
      parent = up;
    }
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    throw modified();
  }
}

// The name the launch points use.
export const verifyPackage = verifyPackageFiles;
