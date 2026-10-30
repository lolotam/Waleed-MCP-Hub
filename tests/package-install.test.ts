import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  PackageProvenanceSchema,
  type PackageProvenance,
} from '@waleed/contracts';
import {
  installPackage,
  type CommitState,
  type SaveOutcome,
} from '../packages/hub-core/src/packages/install.js';
import {
  resolvePackage,
  stagingPackageJson,
} from '../packages/hub-core/src/packages/resolve.js';
import {
  createPackageLock,
  installDirectory,
  jobDirectory,
  markerPath,
} from '../packages/hub-core/src/packages/store.js';
import { buildManifest } from '../packages/hub-core/src/packages/verify.js';
import {
  createPreviewStore,
  type PreviewStore,
} from '../packages/hub-core/src/packages/previews.js';
import {
  scanRoots,
  WATCHDOG_MAX_BYTES,
} from '../packages/hub-core/src/packages/watchdog.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../packages/hub-core/src/ports.js';
import {
  createFixtureRegistry,
  createSimpleTarball,
  sha512Integrity,
  type FixtureRegistry,
} from './helpers/fixture-registry.js';
import { createTestTls, type TestTls } from './helpers/tls.js';

interface FakeProcessRunnerCall {
  request: ProcessRequest;
  command: 'lock' | 'ci' | 'other';
  prefixDir: string | null;
  packageJsonContent: string | null;
}

interface FakeProcessRunnerOptions {
  lock?: unknown;
  outcome?: ProcessResult['outcome'];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  defaultBin?: Record<string, string>;
  onCi?: (
    call: FakeProcessRunnerCall,
  ) => void | ProcessResult | Promise<void | ProcessResult>;
  onLock?: (
    call: FakeProcessRunnerCall,
  ) => void | ProcessResult | Promise<void | ProcessResult>;
  onRun?: (
    call: FakeProcessRunnerCall,
  ) => void | ProcessResult | Promise<void | ProcessResult>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function findFileRecursively(
  dir: string,
  fileName: string,
): Promise<string[]> {
  const matches: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name === fileName) {
        matches.push(fullPath);
      }
      if (entry.isDirectory()) {
        matches.push(...(await findFileRecursively(fullPath, fileName)));
      }
    }
  } catch {
    // folder was removed or inaccessible
  }
  return matches;
}

async function createDefaultCiFiles(
  prefixDir: string,
  name: string,
  version: string,
  binConfig: Record<string, string>,
): Promise<void> {
  const pkgDir = join(prefixDir, 'node_modules', name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, bin: binConfig }, null, 2),
    'utf8',
  );
  for (const entryRelPath of Object.values(binConfig)) {
    const entryFile = join(pkgDir, ...entryRelPath.split('/'));
    await mkdir(dirname(entryFile), { recursive: true });
    await writeFile(
      entryFile,
      '#!/usr/bin/env node\nconsole.log("ok");\n',
      'utf8',
    );
  }
}

function createFakeRunner(options: FakeProcessRunnerOptions = {}) {
  const calls: FakeProcessRunnerCall[] = [];
  const runner: ProcessRunner = {
    async run(request: ProcessRequest): Promise<ProcessResult> {
      const prefixArg = request.arguments.find((arg) =>
        arg.startsWith('--prefix='),
      );
      const prefixDir = prefixArg ? prefixArg.slice('--prefix='.length) : null;
      let packageJsonContent: string | null = null;
      if (prefixDir) {
        try {
          packageJsonContent = await readFile(
            join(prefixDir, 'package.json'),
            'utf8',
          );
        } catch {
          // ignore
        }
      }

      const isLock =
        request.arguments.includes('--package-lock-only') ||
        request.arguments[1] === 'install';
      const isCi = request.arguments[1] === 'ci';
      const command: 'lock' | 'ci' | 'other' = isLock
        ? 'lock'
        : isCi
          ? 'ci'
          : 'other';

      const call: FakeProcessRunnerCall = {
        request,
        command,
        prefixDir,
        packageJsonContent,
      };
      calls.push(call);

      if (isLock && prefixDir && options.lock !== undefined) {
        const lockStr =
          typeof options.lock === 'string'
            ? options.lock
            : JSON.stringify(options.lock, null, 2);
        await writeFile(join(prefixDir, 'package-lock.json'), lockStr, 'utf8');
      }

      if (isCi && prefixDir && !options.onCi) {
        let name = 'srv';
        let version = '1.0.0';
        if (packageJsonContent) {
          try {
            const parsed = JSON.parse(packageJsonContent);
            const deps = parsed.dependencies;
            if (deps && typeof deps === 'object') {
              const keys = Object.keys(deps);
              if (keys.length > 0) {
                name = keys[0]!;
                version = String(deps[name]);
              }
            }
          } catch {
            // ignore
          }
        }
        const binConfig = options.defaultBin ?? { [name]: 'bin/srv.js' };
        await createDefaultCiFiles(prefixDir, name, version, binConfig);
      }

      if (isLock && options.onLock) {
        const res = await options.onLock(call);
        if (res) return res;
      }
      if (isCi && options.onCi) {
        const res = await options.onCi(call);
        if (res) return res;
      }
      if (options.onRun) {
        const res = await options.onRun(call);
        if (res) return res;
      }

      return {
        outcome: options.outcome ?? 'exited',
        exitCode: options.exitCode !== undefined ? options.exitCode : 0,
        stdout: options.stdout ?? '',
        stderr: options.stderr ?? '',
      };
    },
  };
  return { runner, calls };
}

describe('package-install', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  const registries: FixtureRegistry[] = [];
  const previewStores: PreviewStore[] = [];
  let sharedTls: TestTls | null = null;

  beforeAll(async () => {
    sharedTls = await createTestTls();
  }, 60_000);

  afterAll(async () => {
    if (sharedTls) {
      await sharedTls.dispose();
      sharedTls = null;
    }
  });

  afterEach(async () => {
    for (const store of previewStores) {
      await store.dispose();
    }
    previewStores.length = 0;

    for (const reg of registries) {
      await reg.close().catch(() => undefined);
    }
    registries.length = 0;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'wmh-ins-'));
    tempDirs.push(dir);
    return dir;
  }

  async function createRegistry(): Promise<FixtureRegistry> {
    const reg = await createFixtureRegistry({ tls: sharedTls! });
    registries.push(reg);
    return reg;
  }

  function trackPreviewStore(store: PreviewStore): PreviewStore {
    previewStores.push(store);
    return store;
  }

  function createSaveSpy(
    outcome: SaveOutcome = {
      status: 'committed',
      connectorId: 'conn-default',
      outcome: 'saved',
    },
  ) {
    return vi.fn<(provenance: PackageProvenance) => Promise<SaveOutcome>>(
      async () => outcome,
    );
  }

  async function buildPreview(
    registry: FixtureRegistry,
    packagesDir: string,
    previews: PreviewStore,
    options: {
      name?: string;
      version?: string;
      bin?: Record<string, string>;
      lock?: unknown;
      runnerOptions?: FakeProcessRunnerOptions;
      owner?: string;
      dist?: Record<string, unknown>;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    } = {},
  ) {
    const name = options.name ?? 'srv';
    const version = options.version ?? '1.0.0';
    const bin = options.bin ?? { srv: 'bin/srv.js' };
    const owner = options.owner ?? 'test-owner';

    const srvIntegrity = sha512Integrity(`srv-${version}-bytes`);
    const tarballUrl = `${registry.origin}/${name}/-/${name}-${version}.tgz`;

    registry.setVersion(name, version, {
      name,
      version,
      bin,
      dependencies: options.dependencies,
      optionalDependencies: options.optionalDependencies,
      scripts: options.scripts,
      dist: {
        integrity: srvIntegrity,
        tarball: tarballUrl,
        unpackedSize: 1000,
        fileCount: 5,
        ...options.dist,
      },
    });

    registry.setPackage(name, {
      name,
      'dist-tags': { latest: version },
      time: { [version]: '2026-01-01T00:00:00.000Z' },
    });

    const defaultLock = {
      name: 'staging',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'staging', version: '1.0.0' },
        [`node_modules/${name}`]: {
          version,
          integrity: srvIntegrity,
          resolved: `${registry.origin}/${name}/-/${name}-${version}.tgz`,
        },
      },
    };

    const lockToUse = options.lock ?? defaultLock;
    const { runner, calls } = createFakeRunner({
      lock: lockToUse,
      defaultBin: bin,
      ...options.runnerOptions,
    });

    const preview = await resolvePackage({
      request: { name, version },
      owner,
      packagesDir,
      signal: new AbortController().signal,
      previews,
      registry: registry.registry,
      runner,
    });

    const record = await previews.take(preview.previewId, owner);
    return { record, preview, runner, calls, srvIntegrity };
  }

  // 3. Committed
  describe('3. Committed', () => {
    it('commits successfully with matching provenance, manifest, and cleaned markers', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, preview, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      const phases: string[] = [];
      const commitStates: CommitState[] = [];
      const saveSpy = createSaveSpy({
        status: 'committed',
        connectorId: 'conn-1',
        outcome: 'saved',
      });

      const lock = createPackageLock();
      const result = await installPackage({
        record,
        entry: 'srv',
        acknowledgedWarnings: preview.warnings,
        packagesDir,
        lock,
        signal: new AbortController().signal,
        save: saveSpy,
        runner,
        onPhase: (phase) => phases.push(phase),
        onCommitState: (state) => commitStates.push(state),
      });

      expect(phases).toEqual(['downloading', 'verifying', 'saving']);
      expect(commitStates).toEqual(['precommit', 'committing', 'committed']);

      expect(result.connectorId).toBe('conn-1');
      expect(result.outcome).toBe('saved');

      const installFolder = installDirectory(
        packagesDir,
        result.provenance.installId,
      );
      expect(await pathExists(installFolder)).toBe(true);

      const marker = markerPath(packagesDir, result.provenance.installId);
      expect(await pathExists(marker)).toBe(false);

      const jobDir = jobDirectory(packagesDir, record.jobId);
      expect(await pathExists(jobDir)).toBe(false);

      expect(saveSpy).toHaveBeenCalledTimes(1);
      const savedProvenance = saveSpy.mock.calls[0]![0];
      expect(savedProvenance).toEqual(result.provenance);

      const parsedProvenance =
        PackageProvenanceSchema.safeParse(savedProvenance);
      expect(parsedProvenance.success).toBe(true);

      expect(result.provenance.ecosystem).toBe('npm');
      expect(result.provenance.name).toBe(preview.name);
      expect(result.provenance.version).toBe(preview.version);
      expect(result.provenance.entry).toBe('srv');
      expect(result.provenance.entryPath).toBe('bin/srv.js');
      expect(result.provenance.integrity).toBe(preview.integrity);
      expect(result.provenance.lockHash).toBe(preview.lockHash);

      const manifest = await buildManifest(installFolder);
      expect(result.provenance.manifestHash).toBe(manifest.hash);

      const pkgJsonContent = await readFile(
        join(installFolder, 'package.json'),
        'utf8',
      );
      expect(pkgJsonContent).toBe(stagingPackageJson('srv', '1.0.0'));

      const lockJsonContent = await readFile(
        join(installFolder, 'package-lock.json'),
      );
      expect(lockJsonContent).toEqual(Buffer.from(record.lock));
    });
  });

  // 4. not_committed
  describe('4. not_committed', () => {
    it('rejects with error code and deletes install folder, marker, and job folder', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      const saveSpy = createSaveSpy({
        status: 'not_committed',
        error: 'busy',
      });

      const lock = createPackageLock();
      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock,
          signal: new AbortController().signal,
          save: saveSpy,
          runner,
        }),
      ).rejects.toMatchObject({ code: 'busy' });

      const ciCall = calls.find((c) => c.command === 'ci');
      expect(ciCall).toBeDefined();
      const installFolder = ciCall!.prefixDir!;
      const installId = basename(installFolder);

      expect(await pathExists(installFolder)).toBe(false);
      expect(await pathExists(markerPath(packagesDir, installId))).toBe(false);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
    });
  });

  // 5. indeterminate
  describe('5. indeterminate', () => {
    it('rejects with save_uncertain, keeps install folder, removes marker when save returns indeterminate', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      const commitStates: CommitState[] = [];
      const saveSpy = createSaveSpy({
        status: 'indeterminate',
      });

      const lock = createPackageLock();
      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock,
          signal: new AbortController().signal,
          save: saveSpy,
          runner,
          onCommitState: (state) => commitStates.push(state),
        }),
      ).rejects.toMatchObject({ code: 'save_uncertain' });

      expect(commitStates).toEqual([
        'precommit',
        'committing',
        'indeterminate',
      ]);

      const ciCall = calls.find((c) => c.command === 'ci');
      expect(ciCall).toBeDefined();
      const installFolder = ciCall!.prefixDir!;
      const installId = basename(installFolder);

      expect(await pathExists(installFolder)).toBe(true);
      expect(await pathExists(markerPath(packagesDir, installId))).toBe(false);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });

    it('rejects with save_uncertain, keeps install folder, removes marker when save throws', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      const commitStates: CommitState[] = [];
      const saveSpy = vi.fn<
        (provenance: PackageProvenance) => Promise<SaveOutcome>
      >(async () => {
        throw new Error('simulated crash');
      });

      const lock = createPackageLock();
      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock,
          signal: new AbortController().signal,
          save: saveSpy,
          runner,
          onCommitState: (state) => commitStates.push(state),
        }),
      ).rejects.toMatchObject({ code: 'save_uncertain' });

      expect(commitStates).toEqual([
        'precommit',
        'committing',
        'indeterminate',
      ]);

      const ciCall = calls.find((c) => c.command === 'ci');
      expect(ciCall).toBeDefined();
      const installFolder = ciCall!.prefixDir!;
      const installId = basename(installFolder);

      expect(await pathExists(installFolder)).toBe(true);
      expect(await pathExists(markerPath(packagesDir, installId))).toBe(false);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });
  });

  // 6. Pre-checks before ci runner call
  describe('6. Pre-checks before ci runner call', () => {
    it('rejects unknown entry with no_entry before ci call', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      await expect(
        installPackage({
          record,
          entry: 'non-existent-entry',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'no_entry' });

      expect(calls.filter((c) => c.command === 'ci')).toHaveLength(0);
      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
    });

    it('rejects unacknowledged warning with warning_not_acknowledged before ci call', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          scripts: { postinstall: 'echo 1' },
        },
      );

      expect(record.preview.warnings).toContain('install_scripts');

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: [],
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'warning_not_acknowledged' });

      expect(calls.filter((c) => c.command === 'ci')).toHaveLength(0);
      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
    });

    it('rejects aborted signal with cancelled before ci call', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      const controller = new AbortController();
      controller.abort();

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: controller.signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'cancelled' });

      expect(calls.filter((c) => c.command === 'ci')).toHaveLength(0);
      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
    });

    it('rejects unpackedSize > 500 MiB with install_limit before ci call', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      (record.preview as { unpackedSize: number | null }).unpackedSize =
        500 * 1024 * 1024 + 1;

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_limit' });

      expect(calls.filter((c) => c.command === 'ci')).toHaveLength(0);
      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
    });

    it('refuses an ancestor node_modules with install_failed and accepts an ancestor package.json or .npmrc', async () => {
      const tempDir = await createTempDir();
      const subDir = join(tempDir, 'nested');
      const packagesDir = join(subDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner, calls } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      // 1. Ancestor node_modules: Node resolves bare imports from there, so
      // the install is refused before npm runs.
      const nm = join(tempDir, 'node_modules');
      await mkdir(nm, { recursive: true });

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_failed' });

      expect(calls.filter((c) => c.command === 'ci')).toHaveLength(0);
      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      await rm(nm, { recursive: true, force: true });

      // 2. Ancestor package.json: accepted, npm never reads it.
      const pkgJsonPath = join(tempDir, 'package.json');
      await writeFile(pkgJsonPath, '{}', 'utf8');

      const saved = await installPackage({
        record,
        entry: 'srv',
        acknowledgedWarnings: record.preview.warnings,
        packagesDir,
        lock: createPackageLock(),
        signal: new AbortController().signal,
        save: createSaveSpy(),
        runner,
      });
      expect(saved.outcome).toBe('saved');
      expect(calls.filter((c) => c.command === 'ci')).toHaveLength(1);
      await rm(pkgJsonPath);

      // 3. Ancestor .npmrc with a sentinel: accepted, and the sentinel never
      // reaches an argument or an environment value of the npm run.
      const sentinel = 'placeholder-sentinel';
      const npmrcPath = join(tempDir, '.npmrc');
      await writeFile(
        npmrcPath,
        `//foreign.invalid/:_authToken=${sentinel}\nregistry=https://foreign.invalid/\n`,
        'utf8',
      );

      const second = await installPackage({
        record,
        entry: 'srv',
        acknowledgedWarnings: record.preview.warnings,
        packagesDir,
        lock: createPackageLock(),
        signal: new AbortController().signal,
        save: createSaveSpy(),
        runner,
      });
      expect(second.outcome).toBe('saved');
      expect(calls.filter((c) => c.command === 'ci')).toHaveLength(2);

      // Sentinel must never appear in any argument or environment value
      for (const call of calls) {
        for (const arg of call.request.arguments) {
          expect(arg).not.toContain(sentinel);
        }
        for (const val of Object.values(call.request.environment ?? {})) {
          expect(val).not.toContain(sentinel);
        }
      }
      await rm(npmrcPath);
    });
  });

  // 7. Cancel while waiting for the package lock
  describe('7. Cancel while waiting for the package lock', () => {
    it('cancels install while waiting for lock, never calls save, and deletes folders', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
      );

      const lock = createPackageLock();
      const controller = new AbortController();

      let releaseBlocker!: () => void;
      const blockerPromise = lock.run(
        () =>
          new Promise<void>((resolve) => {
            releaseBlocker = resolve;
          }),
      );

      let savingFired = false;
      const saveSpy = createSaveSpy();

      const installPromise = installPackage({
        record,
        entry: 'srv',
        acknowledgedWarnings: record.preview.warnings,
        packagesDir,
        lock,
        signal: controller.signal,
        save: saveSpy,
        runner,
        onPhase: (phase) => {
          if (phase === 'saving') {
            savingFired = true;
            controller.abort();
            releaseBlocker();
          }
        },
      });

      await expect(installPromise).rejects.toMatchObject({ code: 'cancelled' });
      await blockerPromise;

      expect(savingFired).toBe(true);
      expect(saveSpy).not.toHaveBeenCalled();

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });
  });

  // 8. Verification failures
  describe('8. Verification failures', () => {
    it('fails with integrity_mismatch when runner rewrites package-lock.json', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async (call) => {
              await createDefaultCiFiles(call.prefixDir!, 'srv', '1.0.0', {
                srv: 'bin/srv.js',
              });
              await writeFile(
                join(call.prefixDir!, 'package-lock.json'),
                '{"tampered": true}',
                'utf8',
              );
            },
          },
        },
      );

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'integrity_mismatch' });

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });

    it('fails with install_failed when bin path is different from preview', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async (call) => {
              await createDefaultCiFiles(call.prefixDir!, 'srv', '1.0.0', {
                srv: 'bin/other.js',
              });
            },
          },
        },
      );

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_failed' });

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });

    it('fails with install_failed when entry file is missing', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async (call) => {
              const pkgDir = join(call.prefixDir!, 'node_modules', 'srv');
              await mkdir(pkgDir, { recursive: true });
              await writeFile(
                join(pkgDir, 'package.json'),
                JSON.stringify({
                  name: 'srv',
                  version: '1.0.0',
                  bin: { srv: 'bin/srv.js' },
                }),
                'utf8',
              );
              // bin/srv.js is not created
            },
          },
        },
      );

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_failed' });

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });

    it('fails with install_failed when extra top-level file exists', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async (call) => {
              await createDefaultCiFiles(call.prefixDir!, 'srv', '1.0.0', {
                srv: 'bin/srv.js',
              });
              await writeFile(
                join(call.prefixDir!, 'notes.txt'),
                'extra notes',
                'utf8',
              );
            },
          },
        },
      );

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_failed' });

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });

    it.each([
      [
        'a _logs folder',
        (prefix: string) =>
          mkdir(join(prefix, 'node_modules', '_logs'), { recursive: true }),
      ],
      [
        'an .npmrc file',
        (prefix: string) =>
          writeFile(join(prefix, 'node_modules', 'srv', '.npmrc'), ''),
      ],
    ])(
      'fails with install_failed when %s is inside node_modules',
      async (_label, plant) => {
        const tempDir = await createTempDir();
        const packagesDir = join(tempDir, 'packages');
        await mkdir(packagesDir, { recursive: true });

        const registry = await createRegistry();
        const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
        const { record, runner } = await buildPreview(
          registry,
          packagesDir,
          previews,
          {
            runnerOptions: {
              onCi: async (call) => {
                await createDefaultCiFiles(call.prefixDir!, 'srv', '1.0.0', {
                  srv: 'bin/srv.js',
                });
                await plant(call.prefixDir!);
              },
            },
          },
        );

        await expect(
          installPackage({
            record,
            entry: 'srv',
            acknowledgedWarnings: record.preview.warnings,
            packagesDir,
            lock: createPackageLock(),
            signal: new AbortController().signal,
            save: createSaveSpy(),
            runner,
          }),
        ).rejects.toMatchObject({ code: 'install_failed' });

        const entries = await readdir(packagesDir);
        expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
        expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
          false,
        );
      },
    );

    it('fails with install_failed when a hardlinked file exists in tree', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async (call) => {
              await createDefaultCiFiles(call.prefixDir!, 'srv', '1.0.0', {
                srv: 'bin/srv.js',
              });
              const f1 = join(
                call.prefixDir!,
                'node_modules',
                'srv',
                'hard1.txt',
              );
              const f2 = join(
                call.prefixDir!,
                'node_modules',
                'srv',
                'hard2.txt',
              );
              await writeFile(f1, 'content', 'utf8');
              await link(f1, f2);
            },
          },
        },
      );

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_failed' });

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });

    it('fails with install_failed when a junction exists inside node_modules', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const extTarget = join(tempDir, 'external-junc-target');
      await mkdir(extTarget, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async (call) => {
              await createDefaultCiFiles(call.prefixDir!, 'srv', '1.0.0', {
                srv: 'bin/srv.js',
              });
              await symlink(
                extTarget,
                join(call.prefixDir!, 'node_modules', 'srv', 'junc'),
                'junction',
              );
            },
          },
        },
      );

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_failed' });

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });

    it('fails with install_failed when runner exits with 1', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async () => ({
              outcome: 'exited',
              exitCode: 1,
              stdout: '',
              stderr: '',
            }),
          },
        },
      );

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: record.preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_failed' });

      const entries = await readdir(packagesDir);
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });
  });

  // 9. Watchdog breach ordering
  describe('9. Watchdog breach ordering', () => {
    it('handles breach with slow scan and delayed host: install folder exists when runner resolves and deleted afterwards', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      let installFolderExistedBeforeResolve = false;
      let recordedInstallFolder = '';
      let recordedInstallId = '';

      const { record, preview, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          runnerOptions: {
            onCi: async (call) => {
              recordedInstallFolder = call.prefixDir!;
              recordedInstallId = basename(recordedInstallFolder);

              await new Promise<void>((resolve) => {
                if (call.request.signal.aborted) {
                  resolve();
                } else {
                  call.request.signal.addEventListener(
                    'abort',
                    () => resolve(),
                    { once: true },
                  );
                }
              });

              // Delayed host: waits 500 ms after abort
              await new Promise((r) => setTimeout(r, 500));
              installFolderExistedBeforeResolve = await pathExists(
                recordedInstallFolder,
              );

              return {
                outcome: 'cancelled',
                exitCode: null,
                stdout: '',
                stderr: '',
              };
            },
          },
        },
      );

      const watchdog = {
        scan: async (roots: readonly string[]) => {
          await scanRoots(roots);
          await new Promise((r) => setTimeout(r, 100));
          return { bytes: WATCHDOG_MAX_BYTES + 1, files: 1 };
        },
      };

      await expect(
        installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: createSaveSpy(),
          runner,
          watchdog,
        }),
      ).rejects.toMatchObject({ code: 'install_limit' });

      expect(installFolderExistedBeforeResolve).toBe(true);
      expect(await pathExists(recordedInstallFolder)).toBe(false);
      expect(await pathExists(markerPath(packagesDir, recordedInstallId))).toBe(
        false,
      );
      expect(await pathExists(jobDirectory(packagesDir, record.jobId))).toBe(
        false,
      );
    });
  });

  // 10. Bundled entries
  describe('10. Bundled entries', () => {
    it('resolves and installs lock with unpublished and differing bundled entries without registry requests', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-1.0.0-bytes');

      // Register public-dep@1.0.0 in registry (different from bundled 2.0.0)
      registry.setVersion('public-dep', '1.0.0', {
        name: 'public-dep',
        version: '1.0.0',
        dist: {
          integrity: sha512Integrity('public-dep-bytes'),
          unpackedSize: 500,
        },
      });

      // hidden-dep is NOT published in fixture registry

      const customLock = {
        name: 'staging',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'staging', version: '1.0.0' },
          'node_modules/srv': {
            version: '1.0.0',
            integrity: srvIntegrity,
            resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
          },
          'node_modules/srv/node_modules/hidden-dep': {
            version: '0.1.0',
            inBundle: true,
          },
          'node_modules/srv/node_modules/public-dep': {
            version: '2.0.0',
            inBundle: true,
          },
        },
      };

      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const { record, preview, runner } = await buildPreview(
        registry,
        packagesDir,
        previews,
        {
          lock: customLock,
        },
      );

      expect(preview.bundledCount).toBe(2);

      const requests = registry.requests();
      expect(requests.some((r) => r.includes('hidden-dep'))).toBe(false);
      expect(requests.some((r) => r.includes('public-dep'))).toBe(false);

      const saveSpy = createSaveSpy({
        status: 'committed',
        connectorId: 'conn-bundled',
        outcome: 'saved',
      });

      const result = await installPackage({
        record,
        entry: 'srv',
        acknowledgedWarnings: preview.warnings,
        packagesDir,
        lock: createPackageLock(),
        signal: new AbortController().signal,
        save: saveSpy,
        runner,
      });

      expect(result.outcome).toBe('saved');
      const installFolder = installDirectory(
        packagesDir,
        result.provenance.installId,
      );
      expect(await pathExists(installFolder)).toBe(true);
      expect(result.provenance.manifestHash).toBe(
        (await buildManifest(installFolder)).hash,
      );
    });
  });

  // 11. Real npm end-to-end
  describe('11. Real npm end-to-end with postinstall script', () => {
    it.skipIf(process.platform !== 'win32')(
      'ignores postinstall script, generates warning, commits, and builds manifest',
      async () => {
        const tempDir = await createTempDir();
        const packagesDir = join(tempDir, 'packages');
        await mkdir(packagesDir, { recursive: true });

        const registry = await createRegistry();
        const postinstallScript =
          "node -e \"require('fs').writeFileSync(process.env.SENTINEL_PATH || 'POSTINSTALL_RAN', 'x')\"";

        const tarball = await createSimpleTarball(
          {
            'package.json': JSON.stringify({
              name: 'srv',
              version: '1.0.0',
              bin: { srv: 'bin/srv.js' },
              scripts: {
                postinstall: postinstallScript,
              },
            }),
            'bin/srv.js': 'console.log("running srv");',
          },
          tempDir,
        );

        const integrity = sha512Integrity(tarball);
        const tarballUrl = `${registry.origin}/srv/-/srv-1.0.0.tgz`;

        registry.set('/srv/-/srv-1.0.0.tgz', tarball);
        registry.setVersion('srv', '1.0.0', {
          name: 'srv',
          version: '1.0.0',
          bin: { srv: 'bin/srv.js' },
          scripts: {
            postinstall: postinstallScript,
          },
          dist: {
            integrity,
            tarball: tarballUrl,
            unpackedSize: tarball.length,
            fileCount: 2,
          },
        });
        registry.setPackage('srv', {
          _id: 'srv',
          name: 'srv',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'srv',
              version: '1.0.0',
              bin: { srv: 'bin/srv.js' },
              scripts: {
                postinstall: postinstallScript,
              },
              dist: { integrity, tarball: tarballUrl },
            },
          },
          time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        });

        const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
        const owner = 'test-owner-real-11';

        // Runner is omitted: real bundled npm runs
        const preview = await resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner,
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
        });

        expect(preview.warnings).toContain('install_scripts');

        const record = await previews.take(preview.previewId, owner);

        const saveSpy = createSaveSpy({
          status: 'committed',
          connectorId: 'conn-real-11',
          outcome: 'saved',
        });

        const result = await installPackage({
          record,
          entry: 'srv',
          acknowledgedWarnings: preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal: new AbortController().signal,
          save: saveSpy,
          registry: registry.registry,
        });

        expect(result.outcome).toBe('saved');

        // Check POSTINSTALL_RAN does not exist anywhere recursively
        const sentinelMatches = await findFileRecursively(
          tempDir,
          'POSTINSTALL_RAN',
        );
        expect(sentinelMatches).toEqual([]);

        const installFolder = installDirectory(
          packagesDir,
          result.provenance.installId,
        );
        expect(
          await pathExists(
            join(installFolder, 'node_modules', 'srv', 'bin', 'srv.js'),
          ),
        ).toBe(true);

        const manifest = await buildManifest(installFolder);
        expect(result.provenance.manifestHash).toBe(manifest.hash);
      },
      120_000,
    );
  });

  // 12. Real npm unsupported optional dependencies
  describe('12. Real npm unsupported optional dependencies', () => {
    it.skipIf(process.platform !== 'win32')(
      'rejects root optional file: dependency with unsupported_dependency and no requests or install folder',
      async () => {
        const tempDir = await createTempDir();
        const packagesDir = join(tempDir, 'packages');
        await mkdir(packagesDir, { recursive: true });

        const registry = await createRegistry();
        const integrity = sha512Integrity('srv-12a');

        registry.setVersion('srv', '1.0.0', {
          name: 'srv',
          version: '1.0.0',
          bin: { srv: 'bin/srv.js' },
          optionalDependencies: { x: 'file:../x' },
          dist: { integrity, unpackedSize: 500, fileCount: 2 },
        });
        registry.setPackage('srv', {
          name: 'srv',
          'dist-tags': { latest: '1.0.0' },
          time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        });

        const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

        await expect(
          resolvePackage({
            request: { name: 'srv', version: '1.0.0' },
            owner: 'test-owner-12a',
            packagesDir,
            signal: new AbortController().signal,
            previews,
            registry: registry.registry,
          }),
        ).rejects.toMatchObject({ code: 'unsupported_dependency' });

        expect(
          registry
            .requests()
            .some((r) => r.includes('/x') || r.includes('file:')),
        ).toBe(false);

        const entries = await readdir(packagesDir).catch(() => []);
        expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      },
      120_000,
    );

    it.skipIf(process.platform !== 'win32')(
      'rejects transitive optional git dependency with unsupported_dependency and no requests or install folder',
      async () => {
        const tempDir = await createTempDir();
        const packagesDir = join(tempDir, 'packages');
        await mkdir(packagesDir, { recursive: true });

        const registry = await createRegistry();

        const srvTarball = await createSimpleTarball(
          {
            'package.json': JSON.stringify({
              name: 'srv',
              version: '1.0.0',
              bin: { srv: 'bin/srv.js' },
              dependencies: { dep: '^1.0.0' },
            }),
            'bin/srv.js': 'console.log("srv");',
          },
          tempDir,
        );
        const srvIntegrity = sha512Integrity(srvTarball);
        const srvTarballUrl = `${registry.origin}/srv/-/srv-1.0.0.tgz`;
        registry.set('/srv/-/srv-1.0.0.tgz', srvTarball);

        const depTarball = await createSimpleTarball(
          {
            'package.json': JSON.stringify({
              name: 'dep',
              version: '1.0.0',
            }),
          },
          tempDir,
        );
        const depIntegrity = sha512Integrity(depTarball);
        const depTarballUrl = `${registry.origin}/dep/-/dep-1.0.0.tgz`;
        registry.set('/dep/-/dep-1.0.0.tgz', depTarball);

        registry.setVersion('srv', '1.0.0', {
          name: 'srv',
          version: '1.0.0',
          bin: { srv: 'bin/srv.js' },
          dependencies: { dep: '^1.0.0' },
          dist: {
            integrity: srvIntegrity,
            tarball: srvTarballUrl,
            unpackedSize: srvTarball.length,
            fileCount: 2,
          },
        });
        registry.setPackage('srv', {
          name: 'srv',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'srv',
              version: '1.0.0',
              bin: { srv: 'bin/srv.js' },
              dependencies: { dep: '^1.0.0' },
              dist: { integrity: srvIntegrity, tarball: srvTarballUrl },
            },
          },
          time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        });

        registry.setVersion('dep', '1.0.0', {
          name: 'dep',
          version: '1.0.0',
          optionalDependencies: { x: 'git+https://example.invalid/x.git' },
          dist: {
            integrity: depIntegrity,
            tarball: depTarballUrl,
            unpackedSize: depTarball.length,
            fileCount: 1,
          },
        });
        registry.setPackage('dep', {
          name: 'dep',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'dep',
              version: '1.0.0',
              optionalDependencies: { x: 'git+https://example.invalid/x.git' },
              dist: { integrity: depIntegrity, tarball: depTarballUrl },
            },
          },
          time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        });

        const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

        await expect(
          resolvePackage({
            request: { name: 'srv', version: '1.0.0' },
            owner: 'test-owner-12b',
            packagesDir,
            signal: new AbortController().signal,
            previews,
            registry: registry.registry,
          }),
        ).rejects.toMatchObject({ code: 'unsupported_dependency' });

        expect(
          registry
            .requests()
            .some((r) => r.includes('/x') || r.includes('x.git')),
        ).toBe(false);

        const entries = await readdir(packagesDir).catch(() => []);
        expect(entries.filter((e) => !e.startsWith('.'))).toEqual([]);
      },
      120_000,
    );
  });
});
