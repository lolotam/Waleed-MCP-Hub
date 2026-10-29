import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  rm,
  symlink,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createWindowsDiscoveryPorts } from '@waleed/hub-core';

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(
    join(
      process.env.HUB_TEST_TEMP ??
        (process.platform === 'win32' ? 'E:\\Dev\\Temp\\opencode' : tmpdir()),
      'hub-discovery-',
    ),
  );
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')(
  'bounded read-only Windows file discovery',
  () => {
    it('finds shims as metadata, skips relative/UNC PATH entries, and performs no execution or writes', async () => {
      const directory = await temporary();
      await writeFile(
        join(directory, 'opencode.cmd'),
        '@echo synthetic; never execute',
      );
      const ports = createWindowsDiscoveryPorts({
        workingDirectory: directory,
        environment: { PATH: `.;\\\\invalid-host\\share;${directory}` },
      });
      expect(
        await ports.find(['opencode'], new AbortController().signal),
      ).toEqual([join(directory, 'opencode.cmd')]);
      const read = await ports.read(
        join(directory, 'opencode.cmd'),
        new AbortController().signal,
      );
      expect(read.status).toBe('read');
      expect(await readdir(directory)).toEqual(['opencode.cmd']);
      expect(await readFile(join(directory, 'opencode.cmd'), 'utf8')).toBe(
        '@echo synthetic; never execute',
      );
    });
    it('refuses credential caches and oversized files, while distinguishing missing files', async () => {
      const directory = await temporary();
      const ports = createWindowsDiscoveryPorts({
        workingDirectory: directory,
        environment: {},
      });
      const signal = new AbortController().signal;
      await writeFile(
        join(directory, '.credentials.json'),
        'SYNTHETIC-PRIVATE-CACHE',
      );
      await writeFile(
        join(directory, 'large.json'),
        'x'.repeat(1024 * 1024 + 1),
      );
      expect(
        await ports.read(join(directory, '.credentials.json'), signal),
      ).toEqual({ status: 'unsafe' });
      expect(await ports.read(join(directory, 'large.json'), signal)).toEqual({
        status: 'too_large',
      });
      expect(await ports.read(join(directory, 'missing.json'), signal)).toEqual(
        { status: 'missing' },
      );
      expect(await ports.read('relative.json', signal)).toEqual({
        status: 'unsafe',
      });
    });
    it('does not follow a directory junction into another configuration tree', async () => {
      const directory = await temporary();
      const target = await temporary();
      await writeFile(join(target, 'mcp.json'), '{}');
      await mkdir(join(directory, 'root'));
      await symlink(target, join(directory, 'root', 'linked'), 'junction');
      const ports = createWindowsDiscoveryPorts({
        workingDirectory: directory,
        environment: {},
      });
      expect(
        await ports.read(
          join(directory, 'root', 'linked', 'mcp.json'),
          new AbortController().signal,
        ),
      ).toEqual({ status: 'unsafe' });
    });
  },
);
