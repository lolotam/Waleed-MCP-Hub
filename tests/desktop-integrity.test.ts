import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  writeDesktopIntegrity,
  verifyDesktopIntegrity,
} from '../scripts/desktop-integrity.mjs';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function distribution() {
  const directory = await mkdtemp(join(tmpdir(), 'hub-integrity-'));
  directories.push(directory);
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'nested/app.js'), 'synthetic original');
  return directory;
}
it.each(['modified', 'added', 'missing'] as const)(
  'rejects %s portable files rather than accepting a stale inventory',
  async (change) => {
    const directory = await distribution();
    await writeDesktopIntegrity(directory);
    await verifyDesktopIntegrity(directory);
    if (change === 'modified')
      await writeFile(join(directory, 'nested/app.js'), 'synthetic modified');
    if (change === 'added')
      await writeFile(join(directory, 'unexpected.txt'), 'synthetic');
    if (change === 'missing') await rm(join(directory, 'nested/app.js'));
    await expect(verifyDesktopIntegrity(directory)).rejects.toThrow('mismatch');
  },
);
it('rejects directory junctions instead of traversing outside the portable tree', async () => {
  const directory = await distribution(),
    foreign = await distribution();
  await symlink(
    foreign,
    join(directory, 'foreign'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(writeDesktopIntegrity(directory)).rejects.toThrow('links');
});
