import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const tempDirs: string[] = [];

afterEach(async () => {
  plan.opened = 0;
  plan.closed = 0;
  plan.peak = 0;
  plan.abortOnOpen = undefined;
  plan.abortOnPath = undefined;
  plan.controller = undefined;
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
