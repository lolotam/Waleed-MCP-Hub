import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  link,
  type FileHandle,
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
const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;
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
    let isOpen = false;
    try {
      // The decision is made on the open handle, then the path must still
      // name that very file. File ids are compared as exact integers: a
      // Windows file id does not fit in a JavaScript number.
      const file = await open(path, checkedReadFlags);
      isOpen = true;
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A file that vanished after the open is refused. Before the open, a
      // link whose target is missing also fails with ENOENT on Windows: the
      // file is missing only when no existing part of the path is a link.
      if (isOpen) throw conflict();
      await assertNoLinks(path, true);
      return null;
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
