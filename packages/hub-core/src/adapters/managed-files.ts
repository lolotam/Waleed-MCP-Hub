import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  link,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, parse, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HubError } from '../errors.js';
import { hashBytes } from '../runtime/registry.js';

const maxManagedFile = 1024n * 1024n;
// A checked file is opened for reading only. On POSIX the open never blocks on
// a FIFO and never follows a link in the last component; Windows has no FIFOs.
export const checkedReadFlags =
  process.platform === 'win32'
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
export type FileScope = 'catalog' | 'runtime';
export interface ManagedFiles {
  path(scope: FileScope, name: string): string;
  read(scope: FileScope, name: string): Promise<string | null>;
  write(
    scope: FileScope,
    name: string,
    expected: string | null,
    contents: string | null,
  ): Promise<void>;
}
const conflict = () =>
  new HubError(
    'conflict',
    'Managed file changed or is unsafe. Re-preview; no foreign file was intentionally overwritten.',
  );
// The text of a path the hub may touch: absolute, with no UNC, device or
// named-pipe prefix (Windows accepts either separator, so any two leading
// separators are refused) and no control character. It reads only the
// string, so it can run before a file is opened.
export function assertSafePathText(path: string) {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\0\r\n]/.test(path))
    throw conflict();
}
export async function assertNoLinks(path: string, missing = false) {
  assertSafePathText(path);
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw conflict();
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
export function managedFiles(roots: Record<FileScope, string>): ManagedFiles {
  const pathFor = (scope: FileScope, name: string) => {
    if (
      !Object.hasOwn(roots, scope) ||
      !/^wmh-[a-f0-9-]+\.(?:json|mjs)$/.test(name)
    )
      throw conflict();
    return join(roots[scope], name);
  };
  async function read(scope: FileScope, name: string) {
    const path = pathFor(scope, name);
    await assertNoLinks(path, true);
    try {
      // The decision is made on the open handle, then the path must still
      // name that very file. File ids are compared as exact integers: a
      // Windows file id does not fit in a JavaScript number.
      const file = await open(path, checkedReadFlags);
      try {
        const opened = await file.stat({ bigint: true });
        if (
          !opened.isFile() ||
          opened.nlink !== 1n ||
          opened.size > maxManagedFile
        )
          throw conflict();
        // No part of the path may have become a link since the open: an
        // ancestor swapped for a link is refused here, and one swapped back
        // makes the path name a different file than the handle.
        await assertNoLinks(path);
        const named = await lstat(path, { bigint: true });
        if (
          !named.isFile() ||
          named.ino !== opened.ino ||
          named.dev !== opened.dev
        )
          throw conflict();
        return await file.readFile('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    path: pathFor,
    read,
    async write(scope, name, expected, contents) {
      const path = pathFor(scope, name);
      const before = await read(scope, name);
      if (
        (before === null ? null : hashBytes(before)) !== expected ||
        (contents !== null && Buffer.byteLength(contents, 'utf8') > 1024 * 1024)
      )
        throw conflict();
      await assertNoLinks(roots[scope], true);
      await mkdir(roots[scope], { recursive: true, mode: 0o700 });
      await assertNoLinks(roots[scope]);
      if (contents === null) {
        if (before !== null) {
          if (hashBytes((await read(scope, name)) ?? '') !== expected)
            throw conflict();
          await unlink(path);
        }
        return;
      }
      const temporary = join(roots[scope], `wmh-${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        if ((await read(scope, name)) !== before) throw conflict();
        if (expected === null) await link(temporary, path);
        else await rename(temporary, path);
        if ((await readFile(path, 'utf8')) !== contents) throw conflict();
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
  };
}
