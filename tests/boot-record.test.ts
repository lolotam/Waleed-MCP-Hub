import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubError } from '../packages/hub-core/src/errors.js';
import {
  ensureInstallRecord,
  readBootRecord,
  readInstallRecord,
  writeBootRecord,
} from '../packages/hub-core/src/runtime/boot.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(
    join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'wmh-boot-'),
  );
  tempDirs.push(dir);
  return dir;
}

const bootPath = (directory: string) => join(directory, 'boot.json');
const installPath = (directory: string) => join(directory, 'install.json');

describe('boot record', () => {
  it('gives a new identifier per write and keeps the last one', async () => {
    const directory = await createTempDir();
    const first = await writeBootRecord(directory, () => 1_700_000_000_000);
    const second = await writeBootRecord(directory, () => 1_700_000_001_000);

    expect(first.bootId).not.toBe(second.bootId);
    expect(second.startedAt).toBe(1_700_000_001_000);
    await expect(readBootRecord(directory)).resolves.toEqual(second);
    expect(JSON.parse(await readFile(bootPath(directory), 'utf8'))).toEqual(
      second,
    );
  });

  it('refuses a missing record', async () => {
    const directory = await createTempDir();
    await expect(readBootRecord(directory)).rejects.toBeInstanceOf(HubError);
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a malformed record', async () => {
    const directory = await createTempDir();
    await writeFile(bootPath(directory), '{ not json');
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a record with an extra field', async () => {
    const directory = await createTempDir();
    await writeFile(
      bootPath(directory),
      JSON.stringify({
        bootId: randomUUID(),
        startedAt: 1_700_000_000_000,
        extra: 'field',
      }),
    );
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a record that is not a lower-case UUID', async () => {
    const directory = await createTempDir();
    await writeFile(
      bootPath(directory),
      JSON.stringify({ bootId: 'not-a-uuid', startedAt: 1_700_000_000_000 }),
    );
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a record over four kibibytes', async () => {
    const directory = await createTempDir();
    await writeFile(
      bootPath(directory),
      JSON.stringify({
        bootId: randomUUID(),
        startedAt: 1_700_000_000_000,
        padding: 'x'.repeat(4096),
      }),
    );
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a hardlinked record', async () => {
    const directory = await createTempDir();
    await writeFile(
      join(directory, 'copy.json'),
      JSON.stringify({
        bootId: randomUUID(),
        startedAt: 1_700_000_000_000,
      }),
    );
    await link(join(directory, 'copy.json'), bootPath(directory));
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a record that is not a regular file', async () => {
    const directory = await createTempDir();
    await mkdir(bootPath(directory));
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a link in place of the record', async () => {
    const directory = await createTempDir();
    const target = join(directory, 'target');
    await mkdir(target);
    await symlink(target, bootPath(directory), 'junction');
    await expect(readBootRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('install record', () => {
  it('is created once and never rewritten', async () => {
    const directory = await createTempDir();
    const first = await ensureInstallRecord(directory, () => 1_700_000_000_000);
    const raw = await readFile(installPath(directory), 'utf8');
    const second = await ensureInstallRecord(
      directory,
      () => 1_700_003_000_000,
    );

    expect(second.installId).toBe(first.installId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(await readFile(installPath(directory), 'utf8')).toBe(raw);
    await expect(readInstallRecord(directory)).resolves.toEqual(first);
  });

  it('gives the same identifier to two concurrent callers', async () => {
    const directory = await createTempDir();
    const [left, right] = await Promise.all([
      ensureInstallRecord(directory),
      ensureInstallRecord(directory),
    ]);

    expect(left.installId).toBe(right.installId);
    await expect(readInstallRecord(directory)).resolves.toMatchObject({
      installId: left.installId,
    });
  });

  it('refuses a missing record', async () => {
    const directory = await createTempDir();
    await expect(readInstallRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a malformed record', async () => {
    const directory = await createTempDir();
    await writeFile(installPath(directory), '[]');
    await expect(readInstallRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
