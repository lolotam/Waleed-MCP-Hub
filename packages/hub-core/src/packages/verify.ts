import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import type { Connector } from '@waleed/contracts';
import { assertNoLinks } from '../adapters/managed-files.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import {
  NO_GLOBAL_SEARCH_PATHS,
  isPackageEnvName,
  packagesDirOf,
} from '../runtime/registry.js';
import { installDirectory, markerPath } from './store.js';

// Every failure here is a closed failure with a sanitized reason: no path, no
// file name and no content ever reaches the caller.
const modified = () => new RuntimeFault('package_modified');
const MAX_FILES = 50_000;
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

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
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// The installed-file manifest: one line per regular file, sorted, hashed
// together. A link, a hardlinked file or anything that is not a plain file or
// folder fails the walk.
export async function buildManifest(
  installDir: string,
): Promise<PackageManifest> {
  const lines: string[] = [];
  let bytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw modified();
      if (info.isDirectory()) {
        await walk(path, relative);
        continue;
      }
      if (!info.isFile() || info.nlink > 1) throw modified();
      // The caps are checked before hashing, so an oversized file is never read.
      bytes += info.size;
      if (lines.length >= MAX_FILES || bytes > MAX_BYTES) throw modified();
      lines.push(`${relative}\0${info.size}\0${await digest(path)}`);
    }
  };
  const root = await lstat(installDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw modified();
  await walk(installDir, '');
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
): Promise<void> {
  if (connector.executionMode !== 'native' || !connector.package) return;
  const pkg = connector.package;
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
    const lockInfo = await lstat(lockPath);
    if (!lockInfo.isFile() || lockInfo.nlink !== 1) throw modified();
    if (lockInfo.size > MAX_LOCK_BYTES) throw modified();
    const bytes = await readFile(lockPath);
    try {
      if (createHash('sha256').update(bytes).digest('hex') !== pkg.lockHash)
        throw modified();
    } finally {
      bytes.fill(0);
    }
    if ((await buildManifest(installDir)).hash !== pkg.manifestHash)
      throw modified();
    // Node resolves bare imports by walking up the parent folders, so no parent
    // of the install may hold a node_modules entry.
    let parent = resolve(packagesDir);
    for (;;) {
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
