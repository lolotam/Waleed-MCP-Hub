import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { Connector, PackageProvenance } from '@waleed/contracts';
import {
  installDirectory,
  packagesRoot,
} from '../packages/hub-core/src/packages/store.js';
import {
  buildManifest,
  verifyPackageFiles,
} from '../packages/hub-core/src/packages/verify.js';
import { packageArguments } from '../packages/hub-core/src/runtime/registry.js';

type NativeConnector = Extract<Connector, { executionMode: 'native' }>;

// The opened hash streams are counted so a cancelled walk can be shown to
// leave no stream behind.
const plan = vi.hoisted(() => ({
  opened: 0,
  closed: 0,
  peak: 0,
  abortOnOpen: undefined as undefined | number,
  abortOnPath: undefined as undefined | string,
  controller: undefined as undefined | AbortController,
  replacement: undefined as undefined | { path: string; hardlink: boolean },
  wideTree: undefined as undefined | string,
  wideInfo: undefined as undefined | BigIntStats,
  statActive: 0,
  statPeak: 0,
  countedEntries: 0,
  statCounts: new Map<string, number>(),
  abortOnStat: undefined as
    undefined | { path: string; nth: number; controller: AbortController },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (
      path: string,
      options?: Parameters<typeof actual.createReadStream>[1],
    ) => {
      const stream = actual.createReadStream(path, options);
      plan.opened += 1;
      plan.peak = Math.max(plan.peak, plan.opened - plan.closed);
      stream.on('close', () => {
        plan.closed += 1;
      });
      if (plan.abortOnOpen === plan.opened) plan.controller?.abort();
      if (plan.abortOnPath && path.endsWith(plan.abortOnPath))
        stream.once('readable', () => plan.controller?.abort());
      return stream;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      if (plan.replacement && args[0] === plan.replacement.path) {
        const replacement = plan.replacement;
        plan.replacement = undefined;
        await actual.rename(replacement.path, `${replacement.path}.original`);
        if (replacement.hardlink)
          await actual.link(`${replacement.path}.original`, replacement.path);
        else await actual.writeFile(replacement.path, 'evil');
      }
      return actual.open(...args);
    },
    async lstat(...args: Parameters<typeof actual.lstat>) {
      plan.statPeak = Math.max(plan.statPeak, ++plan.statActive);
      try {
        await Promise.resolve();
        if (plan.wideTree && /entry-[0-9]+$/.test(String(args[0]))) {
          plan.countedEntries++;
          return plan.wideInfo!;
        }
        const info = await actual.lstat(...args);
        const key = String(args[0]);
        const count = (plan.statCounts.get(key) ?? 0) + 1;
        plan.statCounts.set(key, count);
        if (plan.abortOnStat?.path === key && plan.abortOnStat.nth === count)
          plan.abortOnStat.controller.abort();
        return info;
      } finally {
        plan.statActive--;
      }
    },
    async opendir(...args: Parameters<typeof actual.opendir>) {
      if (args[0] === plan.wideTree) {
        plan.wideInfo = await actual.lstat(plan.wideTree!, { bigint: true });
        return {
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index < 50_001; index++)
              yield { name: `entry-${index}` };
          },
        };
      }
      return actual.opendir(...args);
    },
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  plan.opened = 0;
  plan.closed = 0;
  plan.peak = 0;
  plan.abortOnOpen = undefined;
  plan.abortOnPath = undefined;
  plan.controller = undefined;
  plan.replacement = undefined;
  plan.wideTree = undefined;
  plan.statCounts.clear();
  plan.abortOnStat = undefined;
  plan.wideInfo = undefined;
  plan.statActive = 0;
  plan.statPeak = 0;
  plan.countedEntries = 0;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(
    join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'wmh-verify-'),
  );
  tempDirs.push(dir);
  return dir;
}

async function createInstall(options?: {
  files?: number;
  large?: boolean;
}): Promise<{ packagesDir: string; connector: NativeConnector }> {
  const dataDir = await createTempDir();
  const packagesDir = packagesRoot(dataDir);
  const installId = randomUUID();
  const installDir = installDirectory(packagesDir, installId);
  const srvDir = join(installDir, 'node_modules', '@scope', 'srv');
  await mkdir(join(srvDir, 'dist'), { recursive: true });

  const lockContent = JSON.stringify({
    name: '@scope/srv',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: {},
  });
  await writeFile(join(installDir, 'package-lock.json'), lockContent);
  const lockHash = createHash('sha256')
    .update(Buffer.from(lockContent))
    .digest('hex');

  await writeFile(join(srvDir, 'dist', 'cli.js'), 'console.log("srv-cli");\n');
  await writeFile(
    join(srvDir, 'package.json'),
    JSON.stringify({
      name: '@scope/srv',
      version: '1.2.3',
      bin: { srv: 'dist/cli.js' },
    }),
  );
  for (let index = 0; index < (options?.files ?? 0); index++)
    await writeFile(join(srvDir, 'dist', `file-${index}.txt`), 'x'.repeat(256));
  if (options?.large)
    await writeFile(
      join(srvDir, 'dist', 'large.bin'),
      Buffer.alloc(16 * 1024 * 1024, 1),
    );

  const pkg: PackageProvenance = {
    ecosystem: 'npm',
    name: '@scope/srv',
    version: '1.2.3',
    entry: 'srv',
    entryPath: 'dist/cli.js',
    installId,
    integrity: `sha512-${'a'.repeat(86)}==`,
    lockHash,
    manifestHash: (await buildManifest(installDir)).hash,
  };
  const connector: NativeConnector = {
    id: 'verify-connector',
    name: 'Verify connector',
    description: 'Managed MCP connector',
    executionMode: 'native',
    transport: 'stdio',
    executable: process.execPath,
    arguments: packageArguments(packagesDir, pkg, []),
    package: pkg,
    environmentLiterals: {},
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
    enabled: true,
    revision: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
  return { packagesDir, connector };
}

describe('cancellable package verification', () => {
  it('rejects an already aborted signal without reading a file', async () => {
    const { packagesDir, connector } = await createInstall({ files: 5 });
    plan.opened = 0;
    plan.closed = 0;
    const controller = new AbortController();
    controller.abort();

    await expect(
      verifyPackageFiles(connector, packagesDir, controller.signal),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    expect(plan.opened).toBe(0);
  });

  it('stops the walk of a folder with many files and leaves no open stream', async () => {
    const { packagesDir, connector } = await createInstall({ files: 40 });
    plan.opened = 0;
    plan.closed = 0;
    const controller = new AbortController();
    plan.controller = controller;
    plan.abortOnOpen = 5;

    await expect(
      verifyPackageFiles(connector, packagesDir, controller.signal),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plan.opened).toBe(5);
    expect(plan.closed).toBe(plan.opened);
  });

  it('destroys the hash stream of a large file when the signal aborts', async () => {
    const { packagesDir, connector } = await createInstall({ large: true });
    plan.opened = 0;
    plan.closed = 0;
    const controller = new AbortController();
    plan.controller = controller;
    plan.abortOnPath = 'large.bin';

    await expect(
      verifyPackageFiles(connector, packagesDir, controller.signal),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plan.opened).toBeGreaterThan(0);
    expect(plan.closed).toBe(plan.opened);
  });

  it('passes a valid install with a live signal', async () => {
    const { packagesDir, connector } = await createInstall({ files: 3 });
    plan.opened = 0;
    plan.closed = 0;
    const controller = new AbortController();

    await expect(
      verifyPackageFiles(connector, packagesDir, controller.signal),
    ).resolves.toBeUndefined();
    expect(plan.closed).toBe(plan.opened);
  });
});

describe('package manifest walk', () => {
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  it('rejects when the signal aborts during the stat that confirms the last directory', async () => {
    const tree = await createTempDir();
    const directory = join(tree, 'only');
    await mkdir(directory);
    await writeFile(join(directory, 'a.txt'), 'x');
    // A dry run counts the stats of the directory; the real run aborts as the
    // last of them completes, whatever the walk did before.
    await buildManifest(tree);
    const last = plan.statCounts.get(directory)!;
    plan.statCounts.clear();
    const controller = new AbortController();
    plan.abortOnStat = { path: directory, nth: last, controller };

    await expect(buildManifest(tree, controller.signal)).rejects.toMatchObject({
      reason: 'cancelled',
    });
    expect(controller.signal.aborted).toBe(true);
  });

  it('hashes the documented manifest of nested, empty and non-ASCII files', async () => {
    const tree = await createTempDir();
    await mkdir(join(tree, 'nested', 'deeper'), { recursive: true });
    await mkdir(join(tree, 'نص'));
    await writeFile(join(tree, 'a.txt'), 'alpha');
    await writeFile(join(tree, 'nested', 'deeper', 'b.js'), '');
    await writeFile(join(tree, 'نص', 'ج.txt'), 'مرحبا');
    const lines = [
      `a.txt\0${5}\0${sha256('alpha')}`,
      `nested/deeper/b.js\0${0}\0${sha256('')}`,
      `نص/ج.txt\0${Buffer.byteLength('مرحبا')}\0${sha256('مرحبا')}`,
    ].sort();

    await expect(buildManifest(tree)).resolves.toEqual({
      hash: sha256(lines.join('\n')),
      files: 3,
      bytes: 5 + Buffer.byteLength('مرحبا'),
    });
  });

  // Regression 2026-10-31: hashing one file at a time took ~5.5 s per
  // 13,584-file ssh-mcp install, so seven peers made the first agent
  // tools/list take 21-30 s and Claude Code timed out.
  it('hashes install files concurrently and closes every stream', async () => {
    const tree = await createTempDir();
    for (let index = 0; index < 24; index++)
      await writeFile(join(tree, `file-${index}.txt`), `content ${index}`);

    await buildManifest(tree);

    expect(plan.peak).toBeGreaterThan(1);
    expect(plan.closed).toBe(plan.opened);
  });
});

for (const hardlink of [false, true])
  it(`rejects a file replaced between enumeration and hashing (hardlink=${hardlink})`, async () => {
    const tree = await createTempDir();
    const path = join(tree, 'entry.txt');
    await writeFile(path, 'safe');
    plan.replacement = { path, hardlink };
    await expect(buildManifest(tree)).rejects.toMatchObject({
      reason: 'package_modified',
    });
    expect(plan.opened).toBe(0);
  });
it('caps streamed directories before scheduling an unbounded stat fan-out', async () => {
  const tree = await createTempDir();
  plan.wideTree = tree;
  await expect(buildManifest(tree)).rejects.toMatchObject({
    reason: 'package_modified',
  });
  expect(plan.countedEntries).toBe(50_000);
  expect(plan.statPeak).toBe(1);
  expect(plan.opened).toBe(0);
}, 20_000);
