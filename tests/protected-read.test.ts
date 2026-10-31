import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileHandle } from 'node:fs/promises';

// The file system is the real one; the hooks only act at the moment a test
// needs: after the handle was checked, or after the file was read.
const hooks = vi.hoisted(() => ({
  // Runs after the stat of the opened handle.
  afterStat: undefined as undefined | (() => Promise<void>),
  // Counts the bytes read through the handle.
  bytesRead: 0,
  // Set once the handle reached the end of the file.
  readDone: false,
  // Changes what lstat reports once the file was read.
  replaced: false,
  // Serves every read one byte at a time, as a growing file can.
  shortReads: false,
  // Every distinct buffer the reader handed to the handle.
  buffers: new Set<Buffer>(),
  // Every path the reader opened.
  opened: [] as string[],
  // Runs once, before the first lstat after the file was read.
  afterRead: undefined as undefined | (() => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrap = (handle: FileHandle): FileHandle =>
    new Proxy(handle, {
      get(target, property, receiver) {
        if (property === 'stat')
          return async (...args: Parameters<FileHandle['stat']>) => {
            const result = await target.stat(...args);
            await hooks.afterStat?.();
            return result;
          };
        if (property === 'read')
          return async (...args: Parameters<FileHandle['read']>) => {
            const [buffer, offset, length, position] = args as unknown as [
              Buffer,
              number,
              number,
              number | null,
            ];
            hooks.buffers.add(buffer);
            const result = await (
              target.read as (...rest: unknown[]) => Promise<{
                bytesRead: number;
              }>
            )(
              ...(hooks.shortReads
                ? [buffer, offset, Math.min(length, 1), position]
                : args),
            );
            hooks.bytesRead += result.bytesRead;
            if (result.bytesRead === 0) hooks.readDone = true;
            return result;
          };
        // A whole-file read is counted too: it is what the bound prevents.
        if (property === 'readFile')
          return async (...args: Parameters<FileHandle['readFile']>) => {
            const result = await target.readFile(...args);
            hooks.bytesRead += result.length;
            hooks.readDone = true;
            return result;
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    const afterRead = hooks.readDone ? hooks.afterRead : undefined;
    if (afterRead) {
      hooks.afterRead = undefined;
      await afterRead();
    }
    const result = await actual.lstat(...args);
    if (!hooks.readDone || !hooks.replaced) return result;
    // Another file now has the path: a different file id.
    return Object.assign(
      Object.create(Object.getPrototypeOf(result) as object) as object,
      result,
      { ino: (result.ino as bigint) + 1n },
    );
  }) as typeof actual.lstat;
  const open = (async (...args: Parameters<typeof actual.open>) => {
    hooks.opened.push(String(args[0]));
    return wrap(await actual.open(...args));
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, lstat, open }, lstat, open };
});

const { mkdtemp, rm, writeFile, appendFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { readProtectedText } =
  await import('../packages/hub-core/src/integrations/bridge.js');

let directory: string;
beforeEach(async () => {
  hooks.afterStat = undefined;
  hooks.bytesRead = 0;
  hooks.readDone = false;
  hooks.replaced = false;
  hooks.shortReads = false;
  hooks.buffers.clear();
  hooks.opened = [];
  hooks.afterRead = undefined;
  directory = await mkdtemp(join(tmpdir(), 'wmh-protected-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('protected file read', () => {
  it('reads a small file through the checked handle', async () => {
    const path = join(directory, 'state.json');
    await writeFile(path, '{"value":"test-value-a"}');
    await expect(readProtectedText(path)).resolves.toBe(
      '{"value":"test-value-a"}',
    );
  });

  it('refuses a file that grows past the limit after the check, reading at most one byte more', async () => {
    const path = join(directory, 'state.json');
    await writeFile(path, '{}');
    // The file grows to five mebibytes once the handle was checked.
    hooks.afterStat = async () => {
      hooks.afterStat = undefined;
      await appendFile(path, Buffer.alloc(5 * 1024 * 1024, 0x20));
    };
    await expect(readProtectedText(path)).rejects.toBeDefined();
    expect(hooks.bytesRead).toBeLessThanOrEqual(4 * 1024 * 1024 + 1);
  });

  it('fills each buffer before it allocates another when every read is short', async () => {
    const path = join(directory, 'state.json');
    const text = JSON.stringify({ value: 'test-value-a'.repeat(100) });
    await writeFile(path, text);
    hooks.shortReads = true;
    await expect(readProtectedText(path)).resolves.toBe(text);
    // About a thousand one-byte reads share one chunk of at most 64 KiB.
    expect(hooks.bytesRead).toBe(Buffer.byteLength(text));
    expect(hooks.buffers.size).toBe(1);
    const allocated = [...hooks.buffers].reduce(
      (sum, buffer) => sum + buffer.length,
      0,
    );
    expect(allocated).toBeLessThanOrEqual(64 * 1024);
  });

  it('refuses a file whose path names another file after the read', async () => {
    const path = join(directory, 'state.json');
    await writeFile(path, '{}');
    hooks.replaced = true;
    await expect(readProtectedText(path)).rejects.toBeDefined();
    expect(hooks.readDone).toBe(true);
  });

  it('refuses a file that grows after the read reached its end', async () => {
    const path = join(directory, 'state.json');
    await writeFile(path, '{}');
    // The file passes the limit once the reader saw its end.
    hooks.afterRead = async () => {
      await appendFile(path, Buffer.alloc(5 * 1024 * 1024, 0x20));
    };
    await expect(readProtectedText(path)).rejects.toBeDefined();
    expect(hooks.readDone).toBe(true);
    expect(hooks.bytesRead).toBe(2);
  });

  it('never opens a network, device or pipe path, or a relative one', async () => {
    for (const path of [
      String.raw`\\server\share\safety.json`,
      String.raw`\\.\pipe\wmh-sample`,
      String.raw`\\?\C:\safety.json`,
      '//server/share/safety.json',
      '//./pipe/wmh-sample',
      String.raw`/\.\pipe\wmh-sample`,
      String.raw`\/server/share/safety.json`,
      'safety.json',
      join(directory, 'safety\n.json'),
    ])
      await expect(readProtectedText(path)).rejects.toBeDefined();
    expect(hooks.opened).toEqual([]);
  });
});
