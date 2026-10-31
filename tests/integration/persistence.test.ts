import {
  link,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, openStateStore, type StateStore } from '@waleed/hub-core';

const directories: string[] = [];
const stores: StateStore[] = [];
async function temporary() {
  const path = await mkdtemp(
    join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'hub-state-'),
  );
  directories.push(path);
  return path;
}
async function open(path: string) {
  const store = await openStateStore(path);
  stores.push(store);
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('atomic JSON state', () => {
  it('locks out another writer, persists revisions, and retains five backups', async () => {
    const directory = await temporary();
    const store = await open(directory);
    await expect(openStateStore(directory)).rejects.toMatchObject({
      code: 'busy',
    });
    for (let revision = 0; revision < 9; revision++)
      await store.write(revision, { ...emptyState(), revision: revision + 1 });
    expect((await store.read()).revision).toBe(9);
    expect(
      JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
        .revision,
    ).toBe(9);
    expect(
      (await readdir(directory)).filter((file) => file.startsWith('backup-')),
    ).toHaveLength(5);
    expect(
      (await readdir(directory)).some((file) => file.endsWith('.tmp')),
    ).toBe(false);
    await expect(
      store.write(0, { ...emptyState(), revision: 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await store.close();
    expect((await (await open(directory)).read()).revision).toBe(9);
  });
  it('refuses external drift and malformed state rather than returning empty success', async () => {
    const directory = await temporary();
    const store = await open(directory);
    await store.write(0, { ...emptyState(), revision: 1 });
    await writeFile(join(directory, 'state.json'), '{bad external data');
    await expect(store.read()).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.write(1, { ...emptyState(), revision: 2 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await store.close();
    await expect(openStateStore(directory)).rejects.toThrow();
    expect((await readdir(directory)).includes('writer.lock')).toBe(false);
  });
  it('refuses a hard-linked state file at open and after a swap', async () => {
    const directory = await temporary();
    const store = await open(directory);
    await store.write(0, { ...emptyState(), revision: 1 });
    // A second name for the state file appears while the hub runs.
    const statePath = join(directory, 'state.json');
    const other = join(await temporary(), 'other.json');
    await link(statePath, other);
    await expect(store.read()).rejects.toMatchObject({ code: 'conflict' });
    await store.close();
    await expect(openStateStore(directory)).rejects.toMatchObject({
      code: 'conflict',
    });
    // Without the second name the same file opens again.
    await rm(other);
    const reopened = await open(directory);
    expect((await reopened.read()).revision).toBe(1);
    // A file swapped in with the same content but as a hard link is refused.
    await rename(statePath, join(directory, 'moved.json'));
    await link(join(directory, 'moved.json'), statePath);
    await expect(reopened.read()).rejects.toMatchObject({ code: 'conflict' });
  });
  it('allows only one overlapping write and validates versions before committing', async () => {
    const directory = await temporary();
    const store = await open(directory);
    const writes = await Promise.allSettled([
      store.write(0, { ...emptyState(), revision: 1 }),
      store.write(0, { ...emptyState(), revision: 1 }),
    ]);
    expect(
      writes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect((await store.read()).revision).toBe(1);
    await expect(
      store.write(1, { ...emptyState(), revision: 3 }),
    ).rejects.toThrow();
  });
});
