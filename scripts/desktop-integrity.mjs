import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const inventoryName = 'desktop-integrity.json';
async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory)).sort()) {
    const name = prefix + entry;
    const path = join(directory, entry),
      metadata = await lstat(path);
    assert(
      !metadata.isSymbolicLink(),
      'Portable artifacts cannot contain links.',
    );
    if (metadata.isDirectory())
      files.push(...Object.entries(await inventory(path, `${name}/`)));
    else {
      assert(
        metadata.isFile() && metadata.nlink === 1,
        'Portable artifacts must be ordinary private copies.',
      );
      if (name !== inventoryName)
        files.push([
          name,
          { bytes: metadata.size, sha256: await fileDigest(path) },
        ]);
    }
  }
  return Object.fromEntries(files);
}
export async function writeDesktopIntegrity(directory) {
  await writeFile(
    join(directory, inventoryName),
    JSON.stringify(
      { protocol: 'wmh-desktop-v1', files: await inventory(directory) },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}
export async function verifyDesktopIntegrity(directory) {
  const manifestPath = join(directory, inventoryName);
  const metadata = await lstat(manifestPath);
  assert(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      metadata.size <= 8 * 1024 * 1024,
    'Invalid portable inventory.',
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.protocol, 'wmh-desktop-v1');
  assert.deepEqual(
    await inventory(directory),
    manifest.files,
    'Portable file inventory/hash mismatch.',
  );
}
