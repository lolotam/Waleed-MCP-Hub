import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  link,
  symlink,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { agentFiles } from '@waleed/hub-core';
it('atomically backs up/updates only allowed files; rejects links, drift and foreign paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-agent-files-'));
  try {
    const path = join(directory, 'config.json'),
      backups = join(directory, 'backups');
    const files = agentFiles([path], backups, async () => undefined);
    await files.replace(path, null, '{"other":"SYNTHETIC-existing-private"}\n');
    const before = await files.read(path);
    const backup = await files.backup('codex', before!);
    expect(backup).toMatch(/\.bak$/);
    expect(await readFile(join(backups, backup), 'utf8')).toBe(before);
    await files.replace(
      path,
      before,
      '{"other":"SYNTHETIC-existing-private","managed":true}\n',
    );
    await expect(files.replace(path, before, '{}')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      files.read(join(directory, 'foreign.json')),
    ).rejects.toBeDefined();
    expect(
      (await readdir(directory)).some((file) => file.endsWith('.tmp')),
    ).toBe(false);
    await link(path, join(directory, 'hardlink.json'));
    await expect(files.read(path)).rejects.toBeDefined();
    await rm(join(directory, 'hardlink.json'));
    await rm(path);
    await mkdir(join(directory, 'target'));
    await writeFile(join(directory, 'target', 'config.json'), '{}');
    await symlink(
      join(directory, 'target'),
      join(directory, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      agentFiles([join(directory, 'linked', 'config.json')], backups).read(
        join(directory, 'linked', 'config.json'),
      ),
    ).rejects.toBeDefined();
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
});
