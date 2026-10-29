import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Connector, HubState, PackageProvenance } from '@waleed/contracts';
import { HubError } from '../packages/hub-core/src/errors.js';
import { RuntimeFault } from '../packages/hub-core/src/runtime/capabilities.js';
import { createCapabilityRuntime } from '../packages/hub-core/src/adapters/mcp/runtime.js';
import { emptyState } from '../packages/hub-core/src/state.js';
import {
  createPackageLock,
  installDirectory,
  jobDirectory,
  markerPath,
  packagesRoot,
  readMarker,
  reconcilePackages,
  removeMarker,
  removeTree,
  writeMarker,
} from '../packages/hub-core/src/packages/store.js';
import {
  buildManifest,
  verifyPackageFiles,
} from '../packages/hub-core/src/packages/verify.js';
import {
  NO_GLOBAL_SEARCH_PATHS,
  packageArguments,
} from '../packages/hub-core/src/runtime/registry.js';

type NativeConnector = Extract<Connector, { executionMode: 'native' }>;

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wmh-pkg-'));
  tempDirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface FakeInstall {
  dataDir: string;
  packagesDir: string;
  installId: string;
  installDir: string;
  lockHash: string;
  manifestHash: string;
  pkg: PackageProvenance;
  connector: NativeConnector;
}

async function createFakeInstall(
  dataDir: string,
  overrides?: {
    installId?: string;
    lockContent?: string;
    files?: Record<string, string>;
    secretBindings?: Record<string, string>;
    environmentLiterals?: Record<string, string>;
  },
): Promise<FakeInstall> {
  const packagesDir = packagesRoot(dataDir);
  const installId = overrides?.installId ?? randomUUID();
  const installDir = installDirectory(packagesDir, installId);
  const srvDir = join(installDir, 'node_modules', '@scope', 'srv');
  const distDir = join(srvDir, 'dist');
  await mkdir(distDir, { recursive: true });

  const lockContent =
    overrides?.lockContent ??
    JSON.stringify({
      name: '@scope/srv',
      version: '1.2.3',
      lockfileVersion: 3,
      packages: {},
    });
  const lockPath = join(installDir, 'package-lock.json');
  await writeFile(lockPath, lockContent);
  const lockHash = createHash('sha256')
    .update(Buffer.from(lockContent))
    .digest('hex');

  const cliPath = join(distDir, 'cli.js');
  await writeFile(cliPath, 'console.log("srv-cli");\n');

  const pkgJsonPath = join(srvDir, 'package.json');
  await writeFile(
    pkgJsonPath,
    JSON.stringify({
      name: '@scope/srv',
      version: '1.2.3',
      bin: { srv: 'dist/cli.js' },
    }),
  );

  if (overrides?.files) {
    for (const [relPath, content] of Object.entries(overrides.files)) {
      const fullPath = join(installDir, relPath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
  }

  const manifest = await buildManifest(installDir);
  const manifestHash = manifest.hash;

  const pkg: PackageProvenance = {
    ecosystem: 'npm',
    name: '@scope/srv',
    version: '1.2.3',
    entry: 'srv',
    entryPath: 'dist/cli.js',
    installId,
    integrity: `sha512-${'a'.repeat(86)}==`,
    lockHash,
    manifestHash,
  };

  const connector: NativeConnector = {
    id: 'test-connector',
    name: 'Test Connector',
    description: 'Managed MCP connector',
    executionMode: 'native',
    transport: 'stdio',
    executable: process.execPath,
    arguments: packageArguments(packagesDir, pkg, []),
    package: pkg,
    environmentLiterals: overrides?.environmentLiterals ?? {},
    secretBindings: overrides?.secretBindings ?? {},
    headerBindings: {},
    trustApproval: null,
    enabled: true,
    revision: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };

  return {
    dataDir,
    packagesDir,
    installId,
    installDir,
    lockHash,
    manifestHash,
    pkg,
    connector,
  };
}

describe('1. Manifest verification (buildManifest)', () => {
  it('produces the same hash for the same directory tree', async () => {
    const dataDir = await createTempDir();
    const tree1 = join(dataDir, 'tree1');
    const tree2 = join(dataDir, 'tree2');

    for (const root of [tree1, tree2]) {
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(root, 'a.txt'), 'file a');
      await writeFile(join(root, 'sub', 'b.txt'), 'file b');
    }

    const manifest1 = await buildManifest(tree1);
    const manifest2 = await buildManifest(tree2);

    expect(manifest1.hash).toBe(manifest2.hash);
    expect(manifest1.files).toBe(manifest2.files);
    expect(manifest1.bytes).toBe(manifest2.bytes);
  });

  it('produces the same hash independent of file and directory creation order', async () => {
    const dataDir = await createTempDir();
    const treeA = join(dataDir, 'treeA');
    const treeB = join(dataDir, 'treeB');

    await mkdir(treeA, { recursive: true });
    await writeFile(join(treeA, 'z.txt'), 'content z');
    await mkdir(join(treeA, 'sub'), { recursive: true });
    await writeFile(join(treeA, 'sub', 'a.txt'), 'content a');
    await writeFile(join(treeA, 'm.txt'), 'content m');

    await mkdir(treeB, { recursive: true });
    await mkdir(join(treeB, 'sub'), { recursive: true });
    await writeFile(join(treeB, 'sub', 'a.txt'), 'content a');
    await writeFile(join(treeB, 'm.txt'), 'content m');
    await writeFile(join(treeB, 'z.txt'), 'content z');

    const manifestA = await buildManifest(treeA);
    const manifestB = await buildManifest(treeB);

    expect(manifestA.hash).toBe(manifestB.hash);
  });

  it('changes hash when file content changes', async () => {
    const dataDir = await createTempDir();
    const tree = join(dataDir, 'tree');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'file.txt'), 'initial content');

    const manifest1 = await buildManifest(tree);

    await writeFile(
      join(tree, 'file.txt'),
      'modified content with different length',
    );
    const manifest2 = await buildManifest(tree);

    expect(manifest2.hash).not.toBe(manifest1.hash);
  });

  it('changes hash when a size-preserving content change occurs', async () => {
    const dataDir = await createTempDir();
    const tree = join(dataDir, 'tree');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'file.txt'), 'hello');

    const manifest1 = await buildManifest(tree);

    await writeFile(join(tree, 'file.txt'), 'world');
    const manifest2 = await buildManifest(tree);

    expect(manifest2.bytes).toBe(manifest1.bytes);
    expect(manifest2.hash).not.toBe(manifest1.hash);
  });

  it('changes hash when a file is added', async () => {
    const dataDir = await createTempDir();
    const tree = join(dataDir, 'tree');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'first.txt'), 'first');

    const manifest1 = await buildManifest(tree);

    await writeFile(join(tree, 'second.txt'), 'second');
    const manifest2 = await buildManifest(tree);

    expect(manifest2.files).toBe(manifest1.files + 1);
    expect(manifest2.hash).not.toBe(manifest1.hash);
  });

  it('changes hash when a file is removed', async () => {
    const dataDir = await createTempDir();
    const tree = join(dataDir, 'tree');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'first.txt'), 'first');
    await writeFile(join(tree, 'second.txt'), 'second');

    const manifest1 = await buildManifest(tree);

    await unlink(join(tree, 'second.txt'));
    const manifest2 = await buildManifest(tree);

    expect(manifest2.files).toBe(manifest1.files - 1);
    expect(manifest2.hash).not.toBe(manifest1.hash);
  });

  it('changes hash when a file is renamed', async () => {
    const dataDir = await createTempDir();
    const tree = join(dataDir, 'tree');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'original.txt'), 'exact-same-content');

    const manifest1 = await buildManifest(tree);

    await rename(join(tree, 'original.txt'), join(tree, 'renamed.txt'));
    const manifest2 = await buildManifest(tree);

    expect(manifest2.bytes).toBe(manifest1.bytes);
    expect(manifest2.files).toBe(manifest1.files);
    expect(manifest2.hash).not.toBe(manifest1.hash);
  });
});

describe('2. Launch verification (verifyPackageFiles)', () => {
  it('passes on a valid install', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir } = await createFakeInstall(dataDir);
    expect(connector.arguments[0]).toBe(NO_GLOBAL_SEARCH_PATHS);
    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).resolves.toBeUndefined();
  });

  it('fails with package_modified when package-lock.json is edited', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installDir } =
      await createFakeInstall(dataDir);
    await writeFile(join(installDir, 'package-lock.json'), '{"tampered":true}');

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toBeInstanceOf(RuntimeFault);
    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when an installed file is edited', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installDir } =
      await createFakeInstall(dataDir);
    const cliPath = join(
      installDir,
      'node_modules',
      '@scope',
      'srv',
      'dist',
      'cli.js',
    );
    await writeFile(cliPath, 'console.log("tampered");');

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when a file is added', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installDir } =
      await createFakeInstall(dataDir);
    const extraPath = join(
      installDir,
      'node_modules',
      '@scope',
      'srv',
      'extra.txt',
    );
    await writeFile(extraPath, 'implanted');

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when a file is removed', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installDir } =
      await createFakeInstall(dataDir);
    const cliPath = join(
      installDir,
      'node_modules',
      '@scope',
      'srv',
      'dist',
      'cli.js',
    );
    await unlink(cliPath);

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when a directory junction inside the install points to an outside folder', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installDir } =
      await createFakeInstall(dataDir);
    const outside = join(dataDir, 'outside-folder');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(installDir, 'junction-link'), 'junction');

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when a hardlinked file is inside the install', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installDir } =
      await createFakeInstall(dataDir);
    const source = join(
      installDir,
      'node_modules',
      '@scope',
      'srv',
      'dist',
      'cli.js',
    );
    const target = join(
      installDir,
      'node_modules',
      '@scope',
      'srv',
      'hardlink.js',
    );
    await link(source, target);

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when marker file <installId>.installing is present next to the folder', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installId } =
      await createFakeInstall(dataDir);
    await writeMarker(packagesDir, installId, randomUUID());

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when a node_modules folder is planted in packagesDir', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir } = await createFakeInstall(dataDir);
    await mkdir(join(packagesDir, 'node_modules'), { recursive: true });

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when a node_modules folder is planted in the data directory', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir } = await createFakeInstall(dataDir);
    await mkdir(join(dataDir, 'node_modules'), { recursive: true });

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when arguments[0] is not --no-global-search-paths', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir } = await createFakeInstall(dataDir);
    const tamperedConnector: NativeConnector = {
      ...connector,
      arguments: ['--some-other-flag', ...connector.arguments.slice(1)],
    };

    await expect(
      verifyPackageFiles(tamperedConnector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when entry argument was built for a different packages folder', async () => {
    const dataDir = await createTempDir();
    const { connector, pkg, packagesDir } = await createFakeInstall(dataDir);
    const foreignPackagesDir = join(dataDir, 'foreign-packages');
    const tamperedConnector: NativeConnector = {
      ...connector,
      arguments: packageArguments(foreignPackagesDir, pkg, []),
    };

    await expect(
      verifyPackageFiles(tamperedConnector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });

  it('fails with package_modified when the install folder is missing', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir, installDir } =
      await createFakeInstall(dataDir);
    await rm(installDir, { recursive: true, force: true });

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });
  });
});

describe('3. Environment literal and secret binding restrictions', () => {
  it('rejects a NODE_OPTIONS environment literal with invalid_configuration', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir } = await createFakeInstall(dataDir, {
      environmentLiterals: { NODE_OPTIONS: '--inspect' },
    });

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'invalid_configuration',
    });
  });

  it('rejects a NODE_EXTRA_CA_CERTS secret binding with invalid_configuration', async () => {
    const dataDir = await createTempDir();
    const { connector, packagesDir } = await createFakeInstall(dataDir, {
      secretBindings: { NODE_EXTRA_CA_CERTS: 'secret-ref-certs' },
    });

    await expect(
      verifyPackageFiles(connector, packagesDir),
    ).rejects.toMatchObject({
      reason: 'invalid_configuration',
    });
  });
});

describe('4. Unmanaged native connector', () => {
  it('resolves without touching the filesystem when package record is omitted', async () => {
    const dataDir = await createTempDir();
    const nonExistentPackagesDir = join(
      dataDir,
      'non-existent-packages-' + randomUUID(),
    );
    const unmanagedConnector: Connector = {
      id: 'unmanaged-connector',
      name: 'Unmanaged Connector',
      description: 'Connector without package record',
      executionMode: 'native',
      transport: 'stdio',
      executable: process.execPath,
      arguments: ['script.js'],
      environmentLiterals: {},
      secretBindings: {},
      headerBindings: {},
      trustApproval: null,
      enabled: true,
      revision: 1,
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T00:00:00.000Z',
    };

    await expect(
      verifyPackageFiles(unmanagedConnector, nonExistentPackagesDir),
    ).resolves.toBeUndefined();
  });
});

describe('5. Launch point ordering (createCapabilityRuntime)', () => {
  it('rejects discover with package_modified on tampered install and never calls resolveBindings or starts process', async () => {
    const dataDir = await createTempDir();
    const { connector, installDir } = await createFakeInstall(dataDir);

    const connectorWithSecret: NativeConnector = {
      ...connector,
      secretBindings: { API_KEY: 'secret-ref-1' },
    };

    // Tamper with the install directory so verifyPackageFiles fails
    await writeFile(
      join(installDir, 'package-lock.json'),
      JSON.stringify({ tampered: true }),
    );

    const resolveBindingsSpy = vi.fn(async () => ({
      environment: {},
      headers: {},
      dispose: () => {},
    }));

    const runtime = createCapabilityRuntime({
      workingDirectory: dataDir,
      resolveBindings: resolveBindingsSpy,
    });

    const controller = new AbortController();
    await expect(
      runtime.discover(connectorWithSecret, controller.signal),
    ).rejects.toMatchObject({
      reason: 'package_modified',
    });

    expect(resolveBindingsSpy).not.toHaveBeenCalled();
  });
});

describe('6. removeTree', () => {
  it('refuses (HubError code invalid) a path outside packagesDir', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const outside = join(dataDir, 'outside-folder');
    await mkdir(outside, { recursive: true });

    await expect(removeTree(outside, packagesDir)).rejects.toBeInstanceOf(
      HubError,
    );
    await expect(removeTree(outside, packagesDir)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('refuses (HubError code invalid) the packages folder itself', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });

    await expect(removeTree(packagesDir, packagesDir)).rejects.toBeInstanceOf(
      HubError,
    );
    await expect(removeTree(packagesDir, packagesDir)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('deletes a nested tree and returns true', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    const nested = join(packagesDir, 'to-delete', 'level1', 'level2');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'file.txt'), 'data');

    const result = await removeTree(
      join(packagesDir, 'to-delete'),
      packagesDir,
    );
    expect(result).toBe(true);
    expect(await exists(join(packagesDir, 'to-delete'))).toBe(false);
  });

  it('removes a junction inside the tree while the sentinel file in the outside target remains intact', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });

    const outside = join(dataDir, 'outside-target');
    await mkdir(outside, { recursive: true });
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'sentinel-keep-alive');

    const tree = join(packagesDir, 'tree-with-junction');
    await mkdir(tree, { recursive: true });
    const junctionPath = join(tree, 'junc');
    await symlink(outside, junctionPath, 'junction');

    const result = await removeTree(tree, packagesDir);
    expect(result).toBe(true);
    expect(await exists(tree)).toBe(false);
    expect(await exists(sentinel)).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('sentinel-keep-alive');
  });
});

describe('7. Markers and identifier validation', () => {
  it('writeMarker then readMarker returns the jobId', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });

    const installId = randomUUID();
    const jobId = randomUUID();

    await writeMarker(packagesDir, installId, jobId);
    const read = await readMarker(packagesDir, installId);
    expect(read).toBe(jobId);
  });

  it('removeMarker is idempotent', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });

    const installId = randomUUID();
    const jobId = randomUUID();

    await writeMarker(packagesDir, installId, jobId);
    await removeMarker(packagesDir, installId);
    expect(await readMarker(packagesDir, installId)).toBeNull();

    await expect(removeMarker(packagesDir, installId)).resolves.toBeUndefined();
  });

  it('refuses non-UUID identifiers in installDirectory, markerPath, jobDirectory, writeMarker', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    const validUuid = randomUUID();
    const badId = 'not-a-valid-uuid';

    expect(() => installDirectory(packagesDir, badId)).toThrow(HubError);
    expect(() => installDirectory(packagesDir, badId)).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(() => markerPath(packagesDir, badId)).toThrow(HubError);
    expect(() => markerPath(packagesDir, badId)).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(() => jobDirectory(packagesDir, badId)).toThrow(HubError);
    expect(() => jobDirectory(packagesDir, badId)).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );

    await expect(
      writeMarker(packagesDir, badId, validUuid),
    ).rejects.toBeInstanceOf(HubError);
    await expect(
      writeMarker(packagesDir, badId, validUuid),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      writeMarker(packagesDir, validUuid, badId),
    ).rejects.toBeInstanceOf(HubError);
    await expect(
      writeMarker(packagesDir, validUuid, badId),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('8. Package lock (createPackageLock)', () => {
  it('executes two run calls strictly in sequential order', async () => {
    const lock = createPackageLock();
    const sequence: string[] = [];
    let firstFinished = false;

    const p1 = lock.run(async () => {
      sequence.push('p1-start');
      await new Promise((resolve) => setTimeout(resolve, 40));
      firstFinished = true;
      sequence.push('p1-end');
      return 'res1';
    });

    const p2 = lock.run(async () => {
      sequence.push('p2-start');
      expect(firstFinished).toBe(true);
      sequence.push('p2-end');
      return 'res2';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(sequence).toEqual(['p1-start', 'p1-end', 'p2-start', 'p2-end']);
    expect(r1).toBe('res1');
    expect(r2).toBe('res2');
  });

  it('does not block the second call when the first call rejects', async () => {
    const lock = createPackageLock();
    let secondRan = false;

    const p1 = lock.run(async () => {
      throw new Error('first-failed');
    });

    const p2 = lock.run(async () => {
      secondRan = true;
      return 'second-succeeded';
    });

    await expect(p1).rejects.toThrow('first-failed');
    await expect(p2).resolves.toBe('second-succeeded');
    expect(secondRan).toBe(true);
  });
});

describe('9. Reconciliation (reconcilePackages)', () => {
  it('deletes an unreferenced install folder without marker and lists it in deleted', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const unrefId = randomUUID();
    const folder = join(packagesDir, unrefId);
    await mkdir(folder);
    await writeFile(join(folder, 'file.txt'), 'unreferenced');

    const result = await reconcilePackages({
      packagesDir,
      readState: async () => emptyState(),
      activeJobs: () => new Set(),
      lock,
    });

    expect(result.deleted).toContain(unrefId);
    expect(result.retained).not.toContain(unrefId);
    expect(await exists(folder)).toBe(false);
  });

  it('keeps a folder referenced by a connector in readState() and lists it in retained', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const refId = randomUUID();
    const folder = join(packagesDir, refId);
    await mkdir(folder);
    await writeFile(join(folder, 'file.txt'), 'referenced');

    const state: HubState = {
      ...emptyState(),
      connectors: [
        {
          id: 'conn-1',
          name: 'Conn 1',
          description: '',
          executionMode: 'native',
          transport: 'stdio',
          executable: process.execPath,
          arguments: [],
          package: {
            ecosystem: 'npm',
            name: '@scope/srv',
            version: '1.0.0',
            entry: 'srv',
            entryPath: 'dist/cli.js',
            installId: refId,
            integrity: 'sha512-test',
            lockHash: 'lock',
            manifestHash: 'manifest',
          },
          environmentLiterals: {},
          secretBindings: {},
          headerBindings: {},
          trustApproval: null,
          enabled: true,
          revision: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
    };

    const result = await reconcilePackages({
      packagesDir,
      readState: async () => state,
      activeJobs: () => new Set(),
      lock,
    });

    expect(result.retained).toContain(refId);
    expect(result.deleted).not.toContain(refId);
    expect(await exists(folder)).toBe(true);
  });

  it('keeps an unreferenced folder whose marker names an active job, then deletes it once job is not active', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const installId = randomUUID();
    const jobId = randomUUID();
    const folder = join(packagesDir, installId);
    await mkdir(folder);
    await writeFile(join(folder, 'file.txt'), 'in-flight');
    await writeMarker(packagesDir, installId, jobId);

    // Active job: folder and marker are kept
    const activeResult = await reconcilePackages({
      packagesDir,
      readState: async () => emptyState(),
      activeJobs: () => new Set([jobId]),
      lock,
    });

    expect(activeResult.retained).toContain(installId);
    expect(activeResult.deleted).not.toContain(installId);
    expect(await exists(folder)).toBe(true);
    expect(await exists(markerPath(packagesDir, installId))).toBe(true);

    // Inactive job: folder and marker are deleted
    const inactiveResult = await reconcilePackages({
      packagesDir,
      readState: async () => emptyState(),
      activeJobs: () => new Set(),
      lock,
    });

    expect(inactiveResult.deleted).toContain(installId);
    expect(inactiveResult.retained).not.toContain(installId);
    expect(await exists(folder)).toBe(false);
    expect(await exists(markerPath(packagesDir, installId))).toBe(false);
  });

  it('keeps both the folder and marker for a referenced folder that still has a marker', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const installId = randomUUID();
    const jobId = randomUUID();
    const folder = join(packagesDir, installId);
    await mkdir(folder);
    await writeFile(join(folder, 'file.txt'), 'referenced-with-marker');
    await writeMarker(packagesDir, installId, jobId);

    const state: HubState = {
      ...emptyState(),
      connectors: [
        {
          id: 'conn-ref-marker',
          name: 'Conn',
          description: '',
          executionMode: 'native',
          transport: 'stdio',
          executable: process.execPath,
          arguments: [],
          package: {
            ecosystem: 'npm',
            name: '@scope/srv',
            version: '1.0.0',
            entry: 'srv',
            entryPath: 'dist/cli.js',
            installId,
            integrity: 'sha512-test',
            lockHash: 'lock',
            manifestHash: 'manifest',
          },
          environmentLiterals: {},
          secretBindings: {},
          headerBindings: {},
          trustApproval: null,
          enabled: true,
          revision: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
    };

    const result = await reconcilePackages({
      packagesDir,
      readState: async () => state,
      activeJobs: () => new Set(), // Job is not active
      lock,
    });

    expect(result.retained).toContain(installId);
    expect(result.deleted).not.toContain(installId);
    expect(await exists(folder)).toBe(true);
    expect(await exists(markerPath(packagesDir, installId))).toBe(true);
  });

  it('deletes a stale .jobs/<jobId> folder and keeps an active one', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const activeJobId = randomUUID();
    const staleJobId = randomUUID();

    const activeFolder = jobDirectory(packagesDir, activeJobId);
    const staleFolder = jobDirectory(packagesDir, staleJobId);

    await mkdir(activeFolder, { recursive: true });
    await writeFile(join(activeFolder, 'active.txt'), 'active');

    await mkdir(staleFolder, { recursive: true });
    await writeFile(join(staleFolder, 'stale.txt'), 'stale');

    const result = await reconcilePackages({
      packagesDir,
      readState: async () => emptyState(),
      activeJobs: () => new Set([activeJobId]),
      lock,
    });

    expect(result.deleted).toContain(staleJobId);
    expect(result.deleted).not.toContain(activeJobId);
    expect(await exists(activeFolder)).toBe(true);
    expect(await exists(staleFolder)).toBe(false);
  });

  it('leaves non-UUID folder names and unrelated files under packagesDir untouched', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const customDir = join(packagesDir, 'not-a-uuid-directory');
    await mkdir(customDir, { recursive: true });
    await writeFile(join(customDir, 'note.txt'), 'hello');

    const customFile = join(packagesDir, 'unrelated.txt');
    await writeFile(customFile, 'content');

    const result = await reconcilePackages({
      packagesDir,
      readState: async () => emptyState(),
      activeJobs: () => new Set(),
      lock,
    });

    expect(result.deleted).not.toContain('not-a-uuid-directory');
    expect(result.retained).not.toContain('not-a-uuid-directory');
    expect(result.deleted).not.toContain('unrelated.txt');
    expect(result.retained).not.toContain('unrelated.txt');
    expect(await exists(customDir)).toBe(true);
    expect(await exists(customFile)).toBe(true);
  });

  it('preserves the install folder when publish+save interleaves with reconcilePackages under the package lock', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const installId = randomUUID();
    const jobId = randomUUID();
    const folder = join(packagesDir, installId);
    await mkdir(folder);
    await writeFile(join(folder, 'cli.js'), 'code');
    await writeMarker(packagesDir, installId, jobId);

    let state = emptyState();
    const connector: Connector = {
      id: 'interleaved-connector',
      name: 'Interleaved',
      description: '',
      executionMode: 'native',
      transport: 'stdio',
      executable: process.execPath,
      arguments: [],
      package: {
        ecosystem: 'npm',
        name: '@scope/srv',
        version: '1.0.0',
        entry: 'srv',
        entryPath: 'dist/cli.js',
        installId,
        integrity: 'sha512-test',
        lockHash: 'lock',
        manifestHash: 'manifest',
      },
      environmentLiterals: {},
      secretBindings: {},
      headerBindings: {},
      trustApproval: null,
      enabled: true,
      revision: 1,
      createdAt: '',
      updatedAt: '',
    };

    // Start publish+save under the lock without awaiting
    const publishAndSave = lock.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await removeMarker(packagesDir, installId);
      state = {
        ...emptyState(),
        connectors: [connector],
      };
    });

    // Call reconcilePackages immediately (without awaiting publishAndSave)
    const reconcilePromise = reconcilePackages({
      packagesDir,
      readState: async () => state,
      activeJobs: () => new Set(),
      lock,
    });

    const [, reconcileResult] = await Promise.all([
      publishAndSave,
      reconcilePromise,
    ]);

    expect(await exists(folder)).toBe(true);
    expect(reconcileResult.retained).toContain(installId);
    expect(reconcileResult.deleted).not.toContain(installId);
  });

  it('guarantees an id appears in at most one of deleted or retained', async () => {
    const dataDir = await createTempDir();
    const packagesDir = packagesRoot(dataDir);
    await mkdir(packagesDir, { recursive: true });
    const lock = createPackageLock();

    const idDeleted = randomUUID();
    await mkdir(join(packagesDir, idDeleted));

    const idRetained = randomUUID();
    await mkdir(join(packagesDir, idRetained));

    const state: HubState = {
      ...emptyState(),
      connectors: [
        {
          id: 'conn-retained',
          name: 'Retained',
          description: '',
          executionMode: 'native',
          transport: 'stdio',
          executable: process.execPath,
          arguments: [],
          package: {
            ecosystem: 'npm',
            name: '@scope/srv',
            version: '1.0.0',
            entry: 'srv',
            entryPath: 'dist/cli.js',
            installId: idRetained,
            integrity: 'sha512-test',
            lockHash: 'lock',
            manifestHash: 'manifest',
          },
          environmentLiterals: {},
          secretBindings: {},
          headerBindings: {},
          trustApproval: null,
          enabled: true,
          revision: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
    };

    const result = await reconcilePackages({
      packagesDir,
      readState: async () => state,
      activeJobs: () => new Set(),
      lock,
    });

    const intersection = result.deleted.filter((id) =>
      result.retained.includes(id),
    );
    expect(intersection).toEqual([]);
    expect(result.deleted).toContain(idDeleted);
    expect(result.retained).toContain(idRetained);
  });
});
