import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { managedFiles } from '@waleed/hub-core';
import { hashBytes } from '../../packages/hub-core/src/runtime/registry.js';

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'hub-managed-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
});
describe('owned managed-file adapter', () => {
  it('rejects free-form/traversal names, performs CAS writes and refuses foreign edits', async () => {
    const directory = await temporary();
    const files = managedFiles({
      runtime: join(directory, 'runtime'),
      catalog: join(directory, 'catalog'),
    });
    expect(() => files.path('catalog', '../outside.json')).toThrow();
    expect(() => files.path('runtime', 'wmh-a.json/../../outside')).toThrow();
    expect(await files.read('catalog', 'wmh-abcd.json')).toBeNull();
    await files.write('catalog', 'wmh-abcd.json', null, '{}');
    await expect(
      files.write('catalog', 'wmh-abcd.json', null, 'overwrite'),
    ).rejects.toBeDefined();
    await writeFile(files.path('catalog', 'wmh-abcd.json'), 'external');
    await expect(
      files.write('catalog', 'wmh-abcd.json', hashBytes('{}'), 'overwrite'),
    ).rejects.toBeDefined();
    expect(await readFile(files.path('catalog', 'wmh-abcd.json'), 'utf8')).toBe(
      'external',
    );
    await files.write('catalog', 'wmh-abcd.json', hashBytes('external'), null);
    expect(await files.read('catalog', 'wmh-abcd.json')).toBeNull();
  });
  it('refuses symlink/junction ancestors and leaves their targets intact', async () => {
    const directory = await temporary();
    const target = await temporary();
    await mkdir(join(directory, 'root'));
    await writeFile(join(target, 'wmh-abcd.json'), 'preserve');
    await symlink(
      target,
      join(directory, 'root', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const files = managedFiles({
      runtime: join(directory, 'runtime'),
      catalog: join(directory, 'root', 'linked'),
    });
    await expect(files.read('catalog', 'wmh-abcd.json')).rejects.toBeDefined();
    await expect(
      files.write('catalog', 'wmh-abcd.json', null, 'bad'),
    ).rejects.toBeDefined();
    expect(await readFile(join(target, 'wmh-abcd.json'), 'utf8')).toBe(
      'preserve',
    );
  });
});
