import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The removal of a temporary install name fails as often as the test says,
// as when another program still holds the name.
const failures = vi.hoisted(() => ({ remaining: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async unlink(path: Parameters<typeof actual.unlink>[0]) {
      if (failures.remaining > 0 && String(path).includes('.wmh-install-')) {
        failures.remaining--;
        throw Object.assign(new Error('held'), { code: 'EPERM' });
      }
      return actual.unlink(path);
    },
  };
});

const { ensureInstallRecord, readInstallRecord } =
  await import('../packages/hub-core/src/runtime/boot.js');

const tempDirs: string[] = [];

afterEach(async () => {
  failures.remaining = 0;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(
    join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'wmh-install-'),
  );
  tempDirs.push(dir);
  return dir;
}

const temporaries = async (directory: string) =>
  (await readdir(directory)).filter((name) => name.endsWith('.tmp'));

describe('the publication of the install record', () => {
  it('retries a temporary name that is held for a moment', async () => {
    const directory = await createTempDir();
    failures.remaining = 2;

    const record = await ensureInstallRecord(directory);
    await expect(readInstallRecord(directory)).resolves.toEqual(record);
    expect(await temporaries(directory)).toEqual([]);
  });

  it('fails instead of returning a record that keeps a second name', async () => {
    const directory = await createTempDir();
    failures.remaining = 100;

    await expect(ensureInstallRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(readInstallRecord(directory)).rejects.toMatchObject({
      code: 'unavailable',
    });

    // The next start removes the second name and keeps the published ID.
    failures.remaining = 0;
    const record = await ensureInstallRecord(directory);
    await expect(readInstallRecord(directory)).resolves.toEqual(record);
    expect(await temporaries(directory)).toEqual([]);
  });
});
