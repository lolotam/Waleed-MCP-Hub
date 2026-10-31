import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import type { Connector } from '@waleed/contracts';
import { assertNoLinks } from '../adapters/managed-files.js';
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
async function digest(
  path: string,
  size: number,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  // A small file gets a small read buffer: most installed files are a few KiB,
  // and a fixed 64 KiB buffer per file dominated the verification time.
  const stream = createReadStream(path, {
    highWaterMark: Math.min(Math.max(size, 1), 64 * 1024),
  });
  if (!signal) {
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  }
  const onAbort = () => stream.destroy(cancelled());
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    for await (const chunk of stream) hash.update(chunk);
    throwIfAborted(signal);
    return hash.digest('hex');
  } catch (error) {
    stream.destroy();
    throw signal.aborted ? cancelled() : error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

interface InstalledFile {
  path: string;
  relative: string;
  size: number;
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
): Promise<{ files: InstalledFile[]; bytes: number }> {
  const files: InstalledFile[] = [];
  let bytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    throwIfAborted(signal);
    const entries = await readdir(directory);
    const infos = await Promise.all(
      entries.map((entry) => lstat(join(directory, entry))),
    );
    throwIfAborted(signal);
    for (const [index, entry] of entries.entries()) {
      const path = join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const info = infos[index]!;
      if (info.isSymbolicLink()) throw modified();
      if (info.isDirectory()) {
        await walk(path, relative);
        continue;
      }
      if (!info.isFile() || info.nlink > 1) throw modified();
      bytes += info.size;
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw modified();
      files.push({ path, relative, size: info.size });
    }
  };
  await walk(installDir, '');
  return { files, bytes };
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
          `${file.relative}\0${file.size}\0${await digest(file.path, file.size, signal)}`;
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
  const { files, bytes } = await listInstalledFiles(installDir, signal);
  const lines = await manifestLines(files, signal);
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
