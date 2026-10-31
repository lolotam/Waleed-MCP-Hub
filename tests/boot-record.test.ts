import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
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

  it('never leaves a partial record from a hub that stopped while writing', async () => {
    const directory = await createTempDir();
    // The hub stopped after writing part of its temporary file, before the
    // link: there is no record yet, only an old temporary file.
    const leftover = join(directory, `.wmh-install-${randomUUID()}.tmp`);
    await writeFile(leftover, '{"installId":');
    const old = new Date(Date.now() - 120_000);
    await utimes(leftover, old, old);

    const record = await ensureInstallRecord(directory);
    await expect(readInstallRecord(directory)).resolves.toEqual(record);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('recovers a record whose temporary name outlived a stopped hub', async () => {
    const directory = await createTempDir();
    const first = await ensureInstallRecord(directory);
    // The hub stopped between the link and the removal of the temporary
    // name: the record has two names and is refused until one is removed.
    await link(
      installPath(directory),
      join(directory, `.wmh-install-${randomUUID()}.tmp`),
    );
    await expect(readInstallRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });

    const again = await ensureInstallRecord(directory);
    expect(again.installId).toBe(first.installId);
    await expect(readInstallRecord(directory)).resolves.toEqual(first);
  });

  it('keeps a fresh temporary file of another hub that is still writing', async () => {
    const directory = await createTempDir();
    const writing = join(directory, `.wmh-install-${randomUUID()}.tmp`);
    await writeFile(writing, '{"installId":');

    await ensureInstallRecord(directory);
    await expect(readFile(writing, 'utf8')).resolves.toBe('{"installId":');
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
