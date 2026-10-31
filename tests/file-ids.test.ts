import { afterEach, expect, it, vi } from 'vitest';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows file ids are 64-bit. These two differ only above 2^53, so they are
// equal as JavaScript numbers and different as exact integers.
const ids = vi.hoisted(() => ({
  target: '',
  named: 2n ** 53n,
  opened: 2n ** 53n + 1n,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Reports `ino` the way Node does: an exact bigint only when asked for one.
  const withId = <T extends object>(
    result: T,
    ino: bigint,
    bigint: boolean | undefined,
  ): T =>
    Object.assign(
      Object.create(Object.getPrototypeOf(result) as object) as object,
      result,
      { ino: bigint ? ino : Number(ino) },
    ) as T;
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    const result = await actual.lstat(...args);
    return args[0] === ids.target
      ? withId(result, ids.named, args[1]?.bigint)
      : result;
  }) as typeof actual.lstat;
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (args[0] !== ids.target) return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === 'stat')
          return async (options?: { bigint?: boolean }) =>
            withId(
              await target.stat(options as { bigint: false }),
              ids.opened,
              options?.bigint,
            );
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as FileHandle;
  }) as typeof actual.open;
  return { ...actual, lstat, open, default: { ...actual, lstat, open } };
});

const { agentFiles } =
  await import('../packages/hub-core/src/integrations/files.js');
const { managedFiles } =
  await import('../packages/hub-core/src/adapters/managed-files.js');
const { readOwnedFile } =
  await import('../packages/hub-core/src/packages/store.js');

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
  ids.target = '';
});

it('refuses an agent file whose opened file id differs only above 2^53', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-agent-ids-'));
  ids.target = join(directory, 'agent.json');
  await writeFile(ids.target, '{}');
  const files = agentFiles([ids.target], join(directory, 'backups'));
  await expect(files.read(ids.target)).rejects.toMatchObject({
    code: 'conflict',
  });
});

it('still reads the file when both ids match exactly', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-agent-ids-'));
  ids.target = join(directory, 'agent.json');
  ids.opened = ids.named;
  await writeFile(ids.target, '{"a":1}');
  const files = agentFiles([ids.target], join(directory, 'backups'));
  await expect(files.read(ids.target)).resolves.toBe('{"a":1}');
  ids.opened = 2n ** 53n + 1n;
});

it('refuses a managed file whose opened file id differs only above 2^53', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-managed-ids-'));
  const roots = {
    runtime: join(directory, 'runtime'),
    catalog: join(directory, 'catalog'),
  };
  const files = managedFiles(roots);
  await files.write('catalog', 'wmh-abcd.json', null, '{}');
  ids.target = files.path('catalog', 'wmh-abcd.json');
  await expect(files.read('catalog', 'wmh-abcd.json')).rejects.toMatchObject({
    code: 'conflict',
  });
  ids.opened = ids.named;
  await expect(files.read('catalog', 'wmh-abcd.json')).resolves.toBe('{}');
  ids.opened = 2n ** 53n + 1n;
});

it('refuses an owned package file whose path names another file id above 2^53', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-owned-ids-'));
  ids.target = join(directory, 'owned.json');
  await writeFile(ids.target, 'x');
  await expect(readOwnedFile(ids.target, 1024)).resolves.toBeNull();
  ids.opened = ids.named;
  expect((await readOwnedFile(ids.target, 1024))?.toString()).toBe('x');
  ids.opened = 2n ** 53n + 1n;
});
