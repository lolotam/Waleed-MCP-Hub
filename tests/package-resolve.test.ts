import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackagePreview, PackageWarning } from '@waleed/contracts';
import { normalizeBin } from '../packages/hub-core/src/packages/entry.js';
import { PackageFault } from '../packages/hub-core/src/packages/fault.js';
import {
  assertNoAncestorProject,
  bundledNpmCli,
  npmArguments,
  npmEnvironment,
  npmFault,
  npmSelfTest,
  prepareJob,
  runNpm,
  type JobPaths,
  type NpmPaths,
  type NpmRunResult,
  type RegistryTarget,
} from '../packages/hub-core/src/packages/npm.js';
import {
  createPreviewStore,
  PREVIEW_TTL_MS,
  type PreviewStore,
} from '../packages/hub-core/src/packages/previews.js';
import {
  isRegistrySpec,
  resolvePackage,
  validateLock,
} from '../packages/hub-core/src/packages/resolve.js';
import {
  createPrivateDirectory,
  jobDirectory,
  removeTree,
} from '../packages/hub-core/src/packages/store.js';
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
  prefixDir: string | null;
  packageJsonContent: string | null;
}

interface FakeProcessRunnerOptions {
  lock?: unknown;
  outcome?: ProcessResult['outcome'];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  onRun?: (call: FakeProcessRunnerCall) => void | Promise<void>;
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
        if (options.lock !== undefined) {
          const lockStr =
            typeof options.lock === 'string'
              ? options.lock
              : JSON.stringify(options.lock, null, 2);
          await writeFile(
            join(prefixDir, 'package-lock.json'),
            lockStr,
            'utf8',
          );
        }
      }
      const call: FakeProcessRunnerCall = {
        request,
        prefixDir,
        packageJsonContent,
      };
      calls.push(call);
      if (options.onRun) {
        await options.onRun(call);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

describe('package-resolve', { timeout: 60_000 }, () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'wmh-res-'));
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

  // 1. isRegistrySpec
  describe('1. isRegistrySpec', () => {
    it('accepts valid registry ranges, versions, and tags', () => {
      const validSpecs = [
        '^1.2.3',
        '1.2.3',
        '*',
        '>=1 <2',
        '1.x || 2',
        'latest',
        'next',
        'beta.1',
      ];
      for (const spec of validSpecs) {
        expect(isRegistrySpec(spec), `expected true for: ${spec}`).toBe(true);
      }
    });

    it('refuses invalid, path, url, git, alias, and workspace specs', () => {
      const invalidSpecs = [
        'a'.repeat(257),
        'evil.tgz',
        'x.tar.gz',
        'file:../a',
        'link:a',
        'workspace:*',
        'npm:foo@1',
        'github:a/b',
        'a/b',
        'git+https://x/y.git',
        'https://x/y.tgz',
        './a',
        'C:\\a',
        '~/a',
      ];
      for (const spec of invalidSpecs) {
        expect(isRegistrySpec(spec), `expected false for: ${spec}`).toBe(false);
      }
    });

    it('accepts an empty range, because npm reads it as the range "*"', () => {
      expect(isRegistrySpec('')).toBe(true);
    });
  });

  // 2. normalizeBin
  describe('2. normalizeBin', () => {
    it('normalizes string bin keyed by unscoped package name', () => {
      expect(normalizeBin('@s/tool', './bin/x.js')).toEqual([
        { entry: 'tool', entryPath: 'bin/x.js' },
      ]);
      expect(normalizeBin('tool', 'bin\\x.js')).toEqual([
        { entry: 'tool', entryPath: 'bin/x.js' },
      ]);
    });

    it('normalizes object bin and sorts entries by entry name', () => {
      const bin = {
        zebra: './bin/z.js',
        alpha: 'bin\\a.js',
        middle: 'bin/m.js',
      };
      expect(normalizeBin('@scope/my-pkg', bin)).toEqual([
        { entry: 'alpha', entryPath: 'bin/a.js' },
        { entry: 'middle', entryPath: 'bin/m.js' },
        { entry: 'zebra', entryPath: 'bin/z.js' },
      ]);
    });

    it('throws no_entry for invalid bin shapes and paths', () => {
      const invalidBins: Array<[string, unknown]> = [
        ['undefined', undefined],
        ['array', []],
        ['empty object', {}],
        [
          'more than 64 entries',
          Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => [`cmd${i}`, `bin/cmd${i}.js`]),
          ),
        ],
        ['absolute path', '/bin/x.js'],
        ['drive path', 'C:/bin/x.js'],
        ['relative traversal', '../x'],
        ['double slash', 'a//b'],
        ['dot segment', 'a/./b'],
        ['invalid entry name', { 'invalid name with spaces': 'bin/x.js' }],
      ];

      for (const [desc, bin] of invalidBins) {
        expect(() => normalizeBin('pkg', bin), `failed on: ${desc}`).toThrow(
          expect.objectContaining({ code: 'no_entry' }),
        );
      }
    });
  });

  // 3. validateLock
  describe('3. validateLock', () => {
    const origin = 'https://registry.npmjs.org';
    const rootIntegrity = sha512Integrity('root-tarball-bytes');
    const depIntegrity = sha512Integrity('dep-tarball-bytes');

    it('accepts v3 lock with root and dependency, counts bundled, and ignores dev/optional', () => {
      const lock = {
        name: 'staging',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'staging', version: '1.0.0' },
          'node_modules/srv': {
            version: '1.0.0',
            integrity: rootIntegrity,
            resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
            hasInstallScript: false,
          },
          'node_modules/dep': {
            version: '2.1.0',
            integrity: depIntegrity,
            resolved: `${origin}/dep/-/dep-2.1.0.tgz`,
            hasInstallScript: true,
          },
          'node_modules/dep/node_modules/bundled-pkg': {
            version: '0.1.0',
            inBundle: true,
          },
          'node_modules/dev-pkg': {
            version: '1.0.0',
            integrity: depIntegrity,
            resolved: `${origin}/dev-pkg/-/dev-pkg-1.0.0.tgz`,
            dev: true,
          },
          'node_modules/optional-pkg': {
            version: '1.0.0',
            integrity: depIntegrity,
            resolved: `${origin}/optional-pkg/-/optional-pkg-1.0.0.tgz`,
            optional: true,
          },
        },
      };

      const result = validateLock(
        lock,
        { name: 'srv', version: '1.0.0', integrity: rootIntegrity },
        origin,
      );

      expect(result.bundledCount).toBe(1);
      expect(result.installed).toEqual([
        {
          key: 'node_modules/dep',
          name: 'dep',
          version: '2.1.0',
          hasInstallScript: true,
        },
        {
          key: 'node_modules/srv',
          name: 'srv',
          version: '1.0.0',
          hasInstallScript: false,
        },
      ]);
    });

    it('refuses invalid locks with unsupported_dependency', () => {
      const baseValid = () => ({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/srv': {
            version: '1.0.0',
            integrity: rootIntegrity,
            resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
          },
        },
      });

      const cases: Array<[string, unknown]> = [
        ['lockfileVersion: 2', { ...baseValid(), lockfileVersion: 2 }],
        ['missing packages', { lockfileVersion: 3 }],
        [
          'link: true',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/linked': { link: true },
            },
          },
        ],
        [
          'key lib/x',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'lib/x': {
                version: '1.0.0',
                integrity: depIntegrity,
                resolved: `${origin}/x/-/x-1.0.0.tgz`,
              },
            },
          },
        ],
        [
          'key node_modules/',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/': {
                version: '1.0.0',
                integrity: depIntegrity,
                resolved: `${origin}/x/-/x-1.0.0.tgz`,
              },
            },
          },
        ],
        [
          'key node_modules/@s',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/@s': {
                version: '1.0.0',
                integrity: depIntegrity,
                resolved: `${origin}/x/-/x-1.0.0.tgz`,
              },
            },
          },
        ],
        [
          'alias name: bar in node_modules/foo',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/foo': {
                name: 'bar',
                version: '1.0.0',
                integrity: depIntegrity,
                resolved: `${origin}/foo/-/foo-1.0.0.tgz`,
              },
            },
          },
        ],
        [
          'resolved on another origin',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/dep': {
                version: '1.0.0',
                integrity: depIntegrity,
                resolved: 'https://evil.org/dep/-/dep-1.0.0.tgz',
              },
            },
          },
        ],
        [
          'resolved file:',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/dep': {
                version: '1.0.0',
                integrity: depIntegrity,
                resolved: 'file:../dep-1.0.0.tgz',
              },
            },
          },
        ],
        [
          'missing integrity',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/dep': {
                version: '1.0.0',
                resolved: `${origin}/dep/-/dep-1.0.0.tgz`,
              },
            },
          },
        ],
        [
          'invalid integrity',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/dep': {
                version: '1.0.0',
                integrity: 'md5-invalidhash',
                resolved: `${origin}/dep/-/dep-1.0.0.tgz`,
              },
            },
          },
        ],
        [
          'invalid version',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: rootIntegrity,
                resolved: `${origin}/srv/-/srv-1.0.0.tgz`,
              },
              'node_modules/dep': {
                version: 'v1.0.0',
                integrity: depIntegrity,
                resolved: `${origin}/dep/-/dep-1.0.0.tgz`,
              },
            },
          },
        ],
        [
          'inBundle root',
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                inBundle: true,
              },
            },
          },
        ],
      ];

      for (const [desc, lock] of cases) {
        expect(
          () =>
            validateLock(
              lock,
              { name: 'srv', version: '1.0.0', integrity: rootIntegrity },
              origin,
            ),
          `failed on: ${desc}`,
        ).toThrow(expect.objectContaining({ code: 'unsupported_dependency' }));
      }
    });

    it('refuses integrity or version mismatch on root with integrity_mismatch', () => {
      const lockWithRootVersion = (ver: string, integ: string) => ({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/srv': {
            version: ver,
            integrity: integ,
            resolved: `${origin}/srv/-/srv-${ver}.tgz`,
          },
        },
      });

      // Different version
      expect(() =>
        validateLock(
          lockWithRootVersion('1.0.1', rootIntegrity),
          { name: 'srv', version: '1.0.0', integrity: rootIntegrity },
          origin,
        ),
      ).toThrow(expect.objectContaining({ code: 'integrity_mismatch' }));

      // Different integrity
      expect(() =>
        validateLock(
          lockWithRootVersion('1.0.0', depIntegrity),
          { name: 'srv', version: '1.0.0', integrity: rootIntegrity },
          origin,
        ),
      ).toThrow(expect.objectContaining({ code: 'integrity_mismatch' }));

      // Missing root
      expect(() =>
        validateLock(
          {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/other': {
                version: '1.0.0',
                integrity: depIntegrity,
                resolved: `${origin}/other/-/other-1.0.0.tgz`,
              },
            },
          },
          { name: 'srv', version: '1.0.0', integrity: rootIntegrity },
          origin,
        ),
      ).toThrow(expect.objectContaining({ code: 'integrity_mismatch' }));
    });
  });

  // 4. createPreviewStore
  describe('4. createPreviewStore', () => {
    it('handles take, owner checks, expiration, directory deletion, and dispose', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      let currentTime = 10_000;
      const fakeNow = () => currentTime;
      const store = trackPreviewStore(
        createPreviewStore({ now: fakeNow, packagesDir }),
      );

      const makePreview = (id: string): PackagePreview => ({
        previewId: id,
        name: 'test-pkg',
        version: '1.0.0',
        description: null,
        integrity: sha512Integrity('test'),
        lockHash: createHash('sha256').update('lock').digest('hex'),
        packageCount: 1,
        bundledCount: 0,
        unpackedSize: 100,
        releasedAt: null,
        entries: [{ entry: 'cmd', entryPath: 'bin/cmd.js' }],
        warnings: [],
        expiresAt: new Date(currentTime + PREVIEW_TTL_MS).toISOString(),
      });

      // take by owner once succeeds, second take gives preview_expired
      const p1 = makePreview(randomUUID());
      const job1 = randomUUID();
      store.put({
        preview: p1,
        lock: new Uint8Array([1, 2, 3]),
        jobId: job1,
        owner: 'owner-a',
      });

      const taken1 = await store.take(p1.previewId, 'owner-a');
      expect(taken1.jobId).toBe(job1);
      await expect(store.take(p1.previewId, 'owner-a')).rejects.toMatchObject({
        code: 'preview_expired',
      });

      // take by another owner gives preview_expired and leaves record in place
      const p2 = makePreview(randomUUID());
      const job2 = randomUUID();
      store.put({
        preview: p2,
        lock: new Uint8Array([4, 5]),
        jobId: job2,
        owner: 'owner-a',
      });

      await expect(store.take(p2.previewId, 'owner-b')).rejects.toMatchObject({
        code: 'preview_expired',
      });
      const taken2 = await store.take(p2.previewId, 'owner-a');
      expect(taken2.jobId).toBe(job2);

      // unknown id gives preview_expired
      await expect(store.take(randomUUID(), 'owner-a')).rejects.toMatchObject({
        code: 'preview_expired',
      });

      // expired record gives preview_expired and deletes job folder
      const p3 = makePreview(randomUUID());
      const job3 = randomUUID();
      const job3Dir = jobDirectory(packagesDir, job3);
      await createPrivateDirectory(job3Dir);
      expect(await pathExists(job3Dir)).toBe(true);

      store.put({
        preview: p3,
        lock: new Uint8Array([6]),
        jobId: job3,
        owner: 'owner-a',
      });

      currentTime += PREVIEW_TTL_MS + 10;
      await expect(store.take(p3.previewId, 'owner-a')).rejects.toMatchObject({
        code: 'preview_expired',
      });
      expect(await pathExists(job3Dir)).toBe(false);

      // real small ttlMs timer deletes job folder by itself
      const shortStore = trackPreviewStore(
        createPreviewStore({ ttlMs: 50, packagesDir }),
      );
      const timerJobId = randomUUID();
      const timerJobDir = jobDirectory(packagesDir, timerJobId);
      await createPrivateDirectory(timerJobDir);
      expect(await pathExists(timerJobDir)).toBe(true);

      shortStore.put({
        preview: makePreview(randomUUID()),
        lock: new Uint8Array([7]),
        jobId: timerJobId,
        owner: 'owner-a',
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await pathExists(timerJobDir)).toBe(false);

      // dispose clears every record and deletes its staging folder
      const p4 = makePreview(randomUUID());
      const disposeJobId = randomUUID();
      const disposeJobDir = jobDirectory(packagesDir, disposeJobId);
      await createPrivateDirectory(disposeJobDir);
      store.put({
        preview: p4,
        lock: new Uint8Array([8]),
        jobId: disposeJobId,
        owner: 'owner-a',
      });
      await store.dispose();
      expect(await pathExists(disposeJobDir)).toBe(false);
      await expect(store.take(p4.previewId, 'owner-a')).rejects.toMatchObject({
        code: 'preview_expired',
      });
    });
  });

  // 4b. The capped preview store
  describe('4b. The capped preview store', () => {
    function makePreview(id: string): PackagePreview {
      return {
        previewId: id,
        name: 'test-pkg',
        version: '1.0.0',
        description: null,
        integrity: sha512Integrity('test'),
        lockHash: createHash('sha256').update('lock').digest('hex'),
        packageCount: 1,
        bundledCount: 0,
        unpackedSize: 100,
        releasedAt: null,
        entries: [{ entry: 'cmd', entryPath: 'bin/cmd.js' }],
        warnings: [],
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      };
    }

    async function waitForRemoval(path: string): Promise<boolean> {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await pathExists(path))) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    }

    it('keeps five previews of one owner and drops the folder of the evicted one', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const store = trackPreviewStore(createPreviewStore({ packagesDir }));
      const previews: string[] = [];
      const jobs: string[] = [];
      for (let index = 0; index < 6; index++) {
        const preview = makePreview(randomUUID());
        const jobId = randomUUID();
        await createPrivateDirectory(jobDirectory(packagesDir, jobId));
        previews.push(preview.previewId);
        jobs.push(jobId);
        store.put({
          preview,
          lock: new Uint8Array([index]),
          jobId,
          owner: 'owner-a',
        });
      }

      // The oldest preview of the owner is gone: it behaves like an expired one.
      expect(store.peek(previews[0]!, 'owner-a')).toBeNull();
      await expect(store.take(previews[0]!, 'owner-a')).rejects.toMatchObject({
        code: 'preview_expired',
      });
      // Its staging folder is gone as well.
      expect(await waitForRemoval(jobDirectory(packagesDir, jobs[0]!))).toBe(
        true,
      );

      // The five newest previews are still there.
      for (const previewId of previews.slice(1))
        expect(store.peek(previewId, 'owner-a')).not.toBeNull();
    });

    it('evicts the global oldest when the store is full', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const store = trackPreviewStore(
        createPreviewStore({ packagesDir, maxTotal: 3 }),
      );
      const put = async (owner: string): Promise<string> => {
        const preview = makePreview(randomUUID());
        const jobId = randomUUID();
        await createPrivateDirectory(jobDirectory(packagesDir, jobId));
        store.put({
          preview,
          lock: new Uint8Array([1]),
          jobId,
          owner,
        });
        return preview.previewId;
      };

      const first = await put('owner-a');
      const second = await put('owner-a');
      const third = await put('owner-b');
      const fourth = await put('owner-b');

      // The global oldest is gone, the other three are still there.
      expect(store.peek(first, 'owner-a')).toBeNull();
      expect(store.peek(second, 'owner-a')).not.toBeNull();
      expect(store.peek(third, 'owner-b')).not.toBeNull();
      expect(store.peek(fourth, 'owner-b')).not.toBeNull();
    });
  });

  // 5. npmArguments / npmEnvironment / prepareJob
  describe('5. npmArguments / npmEnvironment / prepareJob', () => {
    const mockPaths: NpmPaths = {
      prefix: 'C:\\test\\prefix',
      cache: 'C:\\test\\cache',
      tmp: 'C:\\test\\tmp',
      home: 'C:\\test\\home',
      appdata: 'C:\\test\\appdata',
      localappdata: 'C:\\test\\localappdata',
      userNpmrc: 'C:\\test\\user.npmrc',
      globalNpmrc: 'C:\\test\\global.npmrc',
      ca: 'C:\\test\\ca.pem',
    };

    const mockRegistryWithCa: RegistryTarget = {
      host: '127.0.0.1',
      port: 4873,
      origin: 'https://127.0.0.1:4873',
      ca: '---CERT---',
    };

    const mockRegistryNoCa: RegistryTarget = {
      host: '127.0.0.1',
      port: 4873,
      origin: 'https://127.0.0.1:4873',
    };

    it('builds npmArguments with lock and ci flags and isolation settings', () => {
      const lockArgs = npmArguments(
        'lock',
        mockPaths,
        mockRegistryWithCa,
        'http://127.0.0.1:8080',
      );
      expect(lockArgs[0]).toBe(bundledNpmCli());
      expect(lockArgs).toContain('install');
      expect(lockArgs).toContain('--package-lock-only');
      expect(lockArgs).toContain('--ignore-scripts');
      expect(lockArgs).toContain('--omit=dev');
      expect(lockArgs).toContain('--omit=optional');
      expect(lockArgs).toContain('--no-audit');
      expect(lockArgs).toContain('--no-fund');
      expect(lockArgs).toContain('--save-exact');

      const ciArgs = npmArguments(
        'ci',
        mockPaths,
        mockRegistryWithCa,
        'http://127.0.0.1:8080',
      );
      expect(ciArgs[0]).toBe(bundledNpmCli());
      expect(ciArgs).toContain('ci');
      expect(ciArgs).toContain('--ignore-scripts');
      expect(ciArgs).toContain('--omit=dev');
      expect(ciArgs).toContain('--omit=optional');
      expect(ciArgs).toContain('--no-audit');
      expect(ciArgs).toContain('--no-fund');
      expect(ciArgs).not.toContain('--package-lock-only');
      expect(ciArgs).not.toContain('--save-exact');

      for (const args of [lockArgs, ciArgs]) {
        expect(args).toContain('--allow-directory=none');
        expect(args).toContain('--allow-file=none');
        expect(args).toContain('--allow-git=none');
        expect(args).toContain('--allow-remote=none');
        expect(args).toContain('--strict-ssl=true');
        expect(args).toContain('--logs-max=0');
        expect(args).toContain(`--registry=${mockRegistryWithCa.origin}/`);
        expect(args).toContain('--proxy=http://127.0.0.1:8080');
        expect(args).toContain('--https-proxy=http://127.0.0.1:8080');
        expect(args).toContain(`--userconfig=${mockPaths.userNpmrc}`);
        expect(args).toContain(`--globalconfig=${mockPaths.globalNpmrc}`);
        expect(args).toContain(`--cafile=${mockPaths.ca}`);
      }

      // Without CA, --cafile is omitted
      const noCaArgs = npmArguments(
        'lock',
        { ...mockPaths, ca: null },
        mockRegistryNoCa,
        'http://127.0.0.1:8080',
      );
      expect(noCaArgs.some((arg) => arg.startsWith('--cafile='))).toBe(false);
    });

    it('builds npmEnvironment with exactly the allowed keys', () => {
      const env = npmEnvironment(mockPaths);
      expect(Object.keys(env).sort()).toEqual([
        'APPDATA',
        'HOME',
        'LOCALAPPDATA',
        'TEMP',
        'TMP',
        'USERPROFILE',
      ]);
      expect(env.TEMP).toBe(mockPaths.tmp);
      expect(env.TMP).toBe(mockPaths.tmp);
      expect(env.HOME).toBe(mockPaths.home);
      expect(env.USERPROFILE).toBe(mockPaths.home);
      expect(env.APPDATA).toBe(mockPaths.appdata);
      expect(env.LOCALAPPDATA).toBe(mockPaths.localappdata);
      expect(env).not.toHaveProperty('PATH');
      expect(Object.keys(env).some((k) => k.startsWith('npm_config_'))).toBe(
        false,
      );
    });

    it('creates job folders, npmrc files, ca.pem when given, and rejects duplicate jobId', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const jobId = randomUUID();
      const paths: JobPaths = await prepareJob(
        packagesDir,
        jobId,
        mockRegistryWithCa,
      );

      expect(await pathExists(paths.root)).toBe(true);
      expect(await pathExists(paths.project)).toBe(true);
      expect(await pathExists(paths.cache)).toBe(true);
      expect(await pathExists(paths.tmp)).toBe(true);
      expect(await pathExists(paths.home)).toBe(true);
      expect(await pathExists(paths.appdata)).toBe(true);
      expect(await pathExists(paths.localappdata)).toBe(true);
      expect(await readFile(paths.userNpmrc, 'utf8')).toBe('');
      expect(await readFile(paths.globalNpmrc, 'utf8')).toBe('');
      expect(paths.ca).not.toBeNull();
      expect(await readFile(paths.ca!, 'utf8')).toBe(mockRegistryWithCa.ca);

      // Second prepareJob with same jobId rejects
      await expect(
        prepareJob(packagesDir, jobId, mockRegistryWithCa),
      ).rejects.toThrow();

      // Without ca, ca.pem is not written
      const jobId2 = randomUUID();
      const paths2 = await prepareJob(packagesDir, jobId2, mockRegistryNoCa);
      expect(paths2.ca).toBeNull();
      expect(await pathExists(join(paths2.root, 'ca.pem'))).toBe(false);
    }, 30_000);
  });

  // 5b. The proxy and the runner
  describe('5b. The proxy and the runner', () => {
    const registry: RegistryTarget = {
      host: '127.0.0.1',
      port: 4873,
      origin: 'https://127.0.0.1:4873',
    };

    // The listening servers of this process. A proxy that was not closed
    // keeps one of them alive.
    const listeningServers = (): number =>
      process
        .getActiveResourcesInfo()
        .filter((resource) => resource === 'TCPServerWrap').length;

    it('closes the proxy when the runner cannot be created', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });
      const paths = await prepareJob(packagesDir, randomUUID(), registry);

      // No runner is injected and the working folder of the runner does not
      // exist, so the runner cannot be created.
      const before = listeningServers();
      await expect(
        runNpm({
          command: 'lock',
          prefix: join(packagesDir, 'missing-folder'),
          paths,
          registry,
          signal: new AbortController().signal,
          downloadCapBytes: 1024 * 1024,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow();
      // The proxy of the run is closed: no listening server is left behind.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(listeningServers()).toBe(before);
    }, 30_000);
  });

  // 6. npmFault precedence
  describe('6. npmFault precedence', () => {
    it('respects exact fault precedence rules', () => {
      const baseResult: NpmRunResult = {
        outcome: 'exited',
        exitCode: 0,
        downloadedBytes: 100,
        capExceeded: false,
        foreignAttempt: false,
      };

      // 1. Aborted signal gives cancelled regardless of other flags
      const abortedController = new AbortController();
      abortedController.abort();
      expect(
        npmFault(
          {
            ...baseResult,
            foreignAttempt: true,
            capExceeded: true,
            outcome: 'timed_out',
            exitCode: 1,
          },
          abortedController.signal,
        ),
      ).toBe('cancelled');

      // 2. foreign_host precedes cap and exit code
      const liveSignal = new AbortController().signal;
      expect(
        npmFault(
          {
            ...baseResult,
            foreignAttempt: true,
            capExceeded: true,
            outcome: 'timed_out',
            exitCode: 1,
          },
          liveSignal,
        ),
      ).toBe('foreign_host');

      // 3. install_limit precedes exit code and outcome
      expect(
        npmFault(
          {
            ...baseResult,
            foreignAttempt: false,
            capExceeded: true,
            outcome: 'timed_out',
            exitCode: 1,
          },
          liveSignal,
        ),
      ).toBe('install_limit');

      // 4. exitCode 0 gives null
      expect(
        npmFault(
          {
            ...baseResult,
            outcome: 'exited',
            exitCode: 0,
          },
          liveSignal,
        ),
      ).toBeNull();

      // 5. non-zero exit, timed_out, output_limit give install_failed
      expect(
        npmFault(
          {
            ...baseResult,
            outcome: 'exited',
            exitCode: 1,
          },
          liveSignal,
        ),
      ).toBe('install_failed');

      expect(
        npmFault(
          {
            ...baseResult,
            outcome: 'timed_out',
            exitCode: null,
          },
          liveSignal,
        ),
      ).toBe('install_failed');

      expect(
        npmFault(
          {
            ...baseResult,
            outcome: 'output_limit',
            exitCode: null,
          },
          liveSignal,
        ),
      ).toBe('install_failed');
    });
  });

  // 7. assertNoAncestorProject
  describe('7. assertNoAncestorProject', () => {
    it('passes for clean temp tree, accepts an ancestor package.json or .npmrc and refuses an ancestor node_modules', async () => {
      const tempDir = await createTempDir();
      const tree = join(tempDir, 'sub', 'tree');
      const packagesDir = join(tree, 'packages');
      await mkdir(packagesDir, { recursive: true });

      // Clean temp tree passes
      await expect(
        assertNoAncestorProject(packagesDir),
      ).resolves.toBeUndefined();

      // package.json in ancestor: accepted, npm never reads it
      const pkgJson = join(tree, 'package.json');
      await writeFile(pkgJson, '{}');
      await expect(
        assertNoAncestorProject(packagesDir),
      ).resolves.toBeUndefined();
      await rm(pkgJson);

      // .npmrc in ancestor: accepted, the npm runs of the hub use their own
      // configuration files
      const npmrc = join(tree, '.npmrc');
      await writeFile(npmrc, '');
      await expect(
        assertNoAncestorProject(packagesDir),
      ).resolves.toBeUndefined();
      await rm(npmrc);

      // node_modules in ancestor: refused, Node resolves bare imports there
      const nm = join(tree, 'node_modules');
      await mkdir(nm);
      await expect(assertNoAncestorProject(packagesDir)).rejects.toMatchObject({
        code: 'install_failed',
      });
      await rm(nm, { recursive: true, force: true });

      // Clean again passes
      await expect(
        assertNoAncestorProject(packagesDir),
      ).resolves.toBeUndefined();
    });
  });

  // 8. Happy path with fake runner
  describe('8. Happy path with fake runner', () => {
    it('resolves srv@1.0.0 with dep@^2.0.0 locked as 2.1.0', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-tarball-bytes');
      const depIntegrity = sha512Integrity('dep-tarball-bytes');

      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        description: 'Server description',
        bin: {
          'srv-cmd': 'bin/srv.js',
          alpha: 'bin/alpha.js',
        },
        dist: {
          integrity: srvIntegrity,
          unpackedSize: 1000,
          fileCount: 5,
        },
        dependencies: {
          dep: '^2.0.0',
        },
      });

      registry.setPackage('srv', {
        name: 'srv',
        time: {
          '1.0.0': '2026-01-15T12:00:00.000Z',
        },
      });

      registry.setVersion('dep', '2.1.0', {
        name: 'dep',
        version: '2.1.0',
        dist: {
          integrity: depIntegrity,
          unpackedSize: 2000,
          fileCount: 10,
        },
      });

      const lockObject = {
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
          'node_modules/dep': {
            version: '2.1.0',
            integrity: depIntegrity,
            resolved: `${registry.origin}/dep/-/dep-2.1.0.tgz`,
          },
        },
      };

      const lockBytes = Buffer.from(
        JSON.stringify(lockObject, null, 2),
        'utf8',
      );
      const expectedLockHash = createHash('sha256')
        .update(lockBytes)
        .digest('hex');

      const { runner, calls } = createFakeRunner({ lock: lockObject });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const owner = 'test-owner-8';

      const preview = await resolvePackage({
        request: { name: 'srv', version: '1.0.0' },
        owner,
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
      });

      // Preview fields match
      expect(preview.name).toBe('srv');
      expect(preview.version).toBe('1.0.0');
      expect(preview.packageCount).toBe(2);
      expect(preview.unpackedSize).toBe(3000);
      expect(preview.releasedAt).toBe('2026-01-15T12:00:00.000Z');
      expect(preview.entries).toEqual([
        { entry: 'alpha', entryPath: 'bin/alpha.js' },
        { entry: 'srv-cmd', entryPath: 'bin/srv.js' },
      ]);
      expect(preview.lockHash).toBe(expectedLockHash);
      expect(preview.previewId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // previews.take returns same lock bytes
      const record = await previews.take(preview.previewId, owner);
      expect(Buffer.from(record.lock).toString('utf8')).toBe(
        lockBytes.toString('utf8'),
      );

      // Job folder still exists afterwards
      const jobDir = jobDirectory(packagesDir, record.jobId);
      expect(await pathExists(jobDir)).toBe(true);

      // The project package.json the runner saw
      expect(calls).toHaveLength(1);
      expect(calls[0]!.packageJsonContent?.trim()).toBe(
        '{"private":true,"dependencies":{"srv":"1.0.0"}}',
      );
    });
  });

  // 8b. An empty dependency range
  describe('8b. An empty dependency range', () => {
    it('resolves a tree with a dependency written as an empty range', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-empty-range');
      const depIntegrity = sha512Integrity('dep-empty-range');
      const subIntegrity = sha512Integrity('sub-empty-range');

      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dependencies: { dep: '' },
        dist: { integrity: srvIntegrity, unpackedSize: 1000, fileCount: 5 },
      });
      registry.setVersion('dep', '2.1.0', {
        name: 'dep',
        version: '2.1.0',
        dependencies: { sub: '' },
        dist: { integrity: depIntegrity, unpackedSize: 2000, fileCount: 10 },
      });
      registry.setVersion('sub', '3.0.0', {
        name: 'sub',
        version: '3.0.0',
        dist: { integrity: subIntegrity, unpackedSize: 500, fileCount: 1 },
      });

      const lockObject = {
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
          'node_modules/dep': {
            version: '2.1.0',
            integrity: depIntegrity,
            resolved: `${registry.origin}/dep/-/dep-2.1.0.tgz`,
          },
          'node_modules/sub': {
            version: '3.0.0',
            integrity: subIntegrity,
            resolved: `${registry.origin}/sub/-/sub-3.0.0.tgz`,
          },
        },
      };

      const { runner } = createFakeRunner({ lock: lockObject });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      const preview = await resolvePackage({
        request: { name: 'srv', version: '1.0.0' },
        owner: 'test-owner-empty-range',
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
      });

      expect(preview.name).toBe('srv');
      expect(preview.packageCount).toBe(3);
    });
  });

  // 9. version omitted
  describe('9. version omitted', () => {
    it('resolves through dist-tags.latest and request carries accept header', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-latest-bytes');

      registry.set('/srv', {
        name: 'srv',
        'dist-tags': {
          latest: '1.0.0',
        },
        versions: { '1.0.0': { version: '1.0.0' } },
        time: {
          '1.0.0': '2026-01-01T00:00:00.000Z',
        },
      });

      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dist: {
          integrity: srvIntegrity,
          unpackedSize: 500,
        },
      });

      const lockObject = {
        name: 'staging',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/srv': {
            version: '1.0.0',
            integrity: srvIntegrity,
            resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
          },
        },
      };

      const { runner } = createFakeRunner({ lock: lockObject });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      const preview = await resolvePackage({
        request: { name: 'srv' },
        owner: 'test-owner-9',
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
      });

      expect(preview.version).toBe('1.0.0');

      // The abbreviated request carries accept: application/vnd.npm.install-v1+json
      const headers = registry.requestHeaders();
      const abbreviatedReqHeader = headers.find(
        (h) => h.accept === 'application/vnd.npm.install-v1+json',
      );
      expect(abbreviatedReqHeader).toBeDefined();
    });

    // A packument with latest 1.4.0, next 2.0.0-rc.1, a deprecated 1.9.2, a
    // 1.9.3 for no Node at all, and tags npm accepts but a narrow grammar would
    // not; the lookup of one selector: the picked release, or the fault.
    const longTag = 'a'.repeat(80);
    const resolveSelector = async (
      version: string,
      picked: string,
    ): Promise<{ version: string; calls: number }> => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });
      const registry = await createRegistry();
      const releases = [
        '1.2.0',
        '1.4.0',
        '1.9.1',
        '1.9.2',
        '1.9.3',
        '2.0.0-rc.1',
      ];
      registry.set('/srv', {
        name: 'srv',
        'dist-tags': {
          latest: '1.4.0',
          next: '2.0.0-rc.1',
          '123beta': '1.2.0',
          _canary: '1.2.0',
          [longTag]: '1.2.0',
        },
        versions: Object.fromEntries(
          releases.map((release) => [
            release,
            {
              version: release,
              ...(release === '1.9.2' ? { deprecated: 'broken' } : {}),
              ...(release === '1.9.3' ? { engines: { node: '<1' } } : {}),
            },
          ]),
        ),
      });
      for (const release of releases)
        registry.setVersion('srv', release, {
          name: 'srv',
          version: release,
          bin: { srv: 'bin/srv.js' },
          dist: {
            integrity: sha512Integrity(`srv-${release}`),
            unpackedSize: 500,
          },
        });
      const { runner, calls } = createFakeRunner({
        lock: {
          name: 'staging',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': {},
            'node_modules/srv': {
              version: picked,
              integrity: sha512Integrity(`srv-${picked}`),
              resolved: `${registry.origin}/srv/-/srv-${picked}.tgz`,
            },
          },
        },
      });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
      const preview = await resolvePackage({
        request: { name: 'srv', version },
        owner: 'test-owner-9b',
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
      });
      return { version: preview.version, calls: calls.length };
    };

    it('resolves a range to the latest tag when it satisfies the range', async () => {
      expect((await resolveSelector('^1.2.0', '1.4.0')).version).toBe('1.4.0');
    });

    it('resolves a range the latest tag misses to its highest usable release', async () => {
      // 1.9.3 runs on no Node and 1.9.2 is deprecated: npm skips both.
      expect((await resolveSelector('~1.9.0', '1.9.1')).version).toBe('1.9.1');
    });

    it.each(['123beta', '_canary', longTag])(
      'resolves the dist-tag %s, which npm accepts',
      async (tag) => {
        expect((await resolveSelector(tag, '1.2.0')).version).toBe('1.2.0');
      },
    );

    it('resolves a dist-tag to the release it names', async () => {
      expect((await resolveSelector('next', '2.0.0-rc.1')).version).toBe(
        '2.0.0-rc.1',
      );
    });

    it('refuses a range no release satisfies, an unknown tag and a file-shaped tag', async () => {
      for (const selector of ['^3.0.0', 'beta', 'tool.tgz'])
        await expect(resolveSelector(selector, '1.4.0')).rejects.toMatchObject({
          code: 'version_not_found',
        });
    });
  });

  // 10. Refused before the runner is called
  describe('10. Refused before runner is called', () => {
    async function assertRefusedBeforeRunner(
      setup: (registry: FixtureRegistry) => {
        name: string;
        version?: string;
      },
      expectedCode: string,
    ) {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const req = setup(registry);

      const { runner, calls } = createFakeRunner();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      await expect(
        resolvePackage({
          request: req,
          owner: 'test-owner',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          runner,
        }),
      ).rejects.toMatchObject({ code: expectedCode });

      // Runner was never called
      expect(calls).toHaveLength(0);

      // No job folder left in .jobs
      const jobsFolder = join(packagesDir, '.jobs');
      try {
        const entries = await readdir(jobsFolder);
        expect(entries).toHaveLength(0);
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    }

    it('refuses package_not_found for unknown package', async () => {
      await assertRefusedBeforeRunner(
        () => ({ name: 'unknown-package' }),
        'package_not_found',
      );
    });

    it('refuses version_not_found for unknown version or mismatching name/version in document', async () => {
      // 404 for version
      await assertRefusedBeforeRunner((registry) => {
        registry.setPackage('srv', { name: 'srv' });
        return { name: 'srv', version: '2.0.0' };
      }, 'version_not_found');

      // Document has different name
      await assertRefusedBeforeRunner((registry) => {
        registry.setVersion('srv', '1.0.0', {
          name: 'other-pkg',
          version: '1.0.0',
        });
        return { name: 'srv', version: '1.0.0' };
      }, 'version_not_found');

      // Document has different version
      await assertRefusedBeforeRunner((registry) => {
        registry.setVersion('srv', '1.0.0', {
          name: 'srv',
          version: '1.0.1',
        });
        return { name: 'srv', version: '1.0.0' };
      }, 'version_not_found');
    });

    it('refuses integrity_mismatch for missing dist.integrity', async () => {
      await assertRefusedBeforeRunner((registry) => {
        registry.setVersion('srv', '1.0.0', {
          name: 'srv',
          version: '1.0.0',
          bin: { srv: 'bin/srv.js' },
          dist: {},
        });
        return { name: 'srv', version: '1.0.0' };
      }, 'integrity_mismatch');
    });

    it('refuses no_entry for missing or invalid bin', async () => {
      await assertRefusedBeforeRunner((registry) => {
        registry.setVersion('srv', '1.0.0', {
          name: 'srv',
          version: '1.0.0',
          dist: { integrity: sha512Integrity('b') },
        });
        return { name: 'srv', version: '1.0.0' };
      }, 'no_entry');
    });

    it('refuses unsupported_dependency for root dependencies/optional/peer specs of file:, npm:, github:, or .tgz', async () => {
      const specs = [
        { field: 'dependencies', spec: 'file:../local' },
        { field: 'dependencies', spec: 'npm:alias@1.0.0' },
        { field: 'optionalDependencies', spec: 'github:user/repo' },
        { field: 'peerDependencies', spec: 'https://example.com/pkg.tgz' },
        // Tag-shaped, but npm reads it as a local file.
        { field: 'dependencies', spec: 'x.tgz' },
      ];

      for (const { field, spec } of specs) {
        await assertRefusedBeforeRunner((registry) => {
          registry.setVersion('srv', '1.0.0', {
            name: 'srv',
            version: '1.0.0',
            bin: { srv: 'bin/srv.js' },
            dist: { integrity: sha512Integrity('b') },
            [field]: { dep: spec },
          });
          return { name: 'srv', version: '1.0.0' };
        }, 'unsupported_dependency');
      }
    });
  });

  // 11. Refused after runner is called
  describe('11. Refused after runner is called', () => {
    async function assertRefusedAfterRunner(
      runnerOptions:
        | FakeProcessRunnerOptions
        | ((
            registry: FixtureRegistry,
            srvIntegrity: string,
          ) => FakeProcessRunnerOptions),
      setupRegistry: (registry: FixtureRegistry, srvIntegrity: string) => void,
      expectedCode: string,
    ) {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-after-runner');

      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dist: { integrity: srvIntegrity, unpackedSize: 1000, fileCount: 2 },
      });
      registry.setPackage('srv', {
        name: 'srv',
        time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
      });

      setupRegistry(registry, srvIntegrity);

      const resolvedRunnerOptions =
        typeof runnerOptions === 'function'
          ? runnerOptions(registry, srvIntegrity)
          : runnerOptions;

      const { runner, calls } = createFakeRunner(resolvedRunnerOptions);
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      await expect(
        resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          runner,
        }),
      ).rejects.toMatchObject({ code: expectedCode });

      // Runner was called
      expect(calls.length).toBeGreaterThanOrEqual(1);

      // Job folder is deleted afterwards
      const jobsFolder = join(packagesDir, '.jobs');
      try {
        const entries = await readdir(jobsFolder);
        expect(entries).toHaveLength(0);
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    }

    it('refuses install_failed on runner exit 1', async () => {
      await assertRefusedAfterRunner(
        { outcome: 'exited', exitCode: 1, stderr: 'npm error' },
        () => undefined,
        'install_failed',
      );
    });

    it('refuses unsupported_dependency for forbidden lock entry', async () => {
      await assertRefusedAfterRunner(
        {
          lock: {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: sha512Integrity('srv-after-runner'),
                resolved: 'https://other-registry.com/srv.tgz',
              },
            },
          },
        },
        () => undefined,
        'unsupported_dependency',
      );
    });

    it('refuses unsupported_dependency for transitive doc with file: dep', async () => {
      const depInteg = sha512Integrity('dep-integ');
      await assertRefusedAfterRunner(
        (registry, srvIntegrity) => ({
          lock: {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: srvIntegrity,
                resolved: `${registry.origin}/srv.tgz`,
              },
              'node_modules/dep': {
                version: '2.0.0',
                integrity: depInteg,
                resolved: `${registry.origin}/dep.tgz`,
              },
            },
          },
        }),
        (registry) => {
          registry.setVersion('dep', '2.0.0', {
            name: 'dep',
            version: '2.0.0',
            dependencies: { sub: 'file:../sub' },
            dist: { integrity: depInteg },
          });
        },
        'unsupported_dependency',
      );
    }, 30_000);

    it('refuses unsupported_dependency for missing transitive doc', async () => {
      const depInteg = sha512Integrity('dep-integ');
      await assertRefusedAfterRunner(
        (registry, srvIntegrity) => ({
          lock: {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: srvIntegrity,
                resolved: `${registry.origin}/srv.tgz`,
              },
              'node_modules/dep': {
                version: '2.0.0',
                integrity: depInteg,
                resolved: `${registry.origin}/dep.tgz`,
              },
            },
          },
        }),
        () => undefined,
        'unsupported_dependency',
      );
    }, 30_000);

    it('refuses integrity_mismatch when lock root integrity differs from document', async () => {
      await assertRefusedAfterRunner(
        (registry) => ({
          lock: {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: sha512Integrity('different-integrity'),
                resolved: `${registry.origin}/srv.tgz`,
              },
            },
          },
        }),
        () => undefined,
        'integrity_mismatch',
      );
    }, 30_000);

    it('refuses install_limit when unpackedSize > 500 MiB', async () => {
      const depInteg = sha512Integrity('dep-integ');
      await assertRefusedAfterRunner(
        (registry, srvIntegrity) => ({
          lock: {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: srvIntegrity,
                resolved: `${registry.origin}/srv.tgz`,
              },
              'node_modules/dep': {
                version: '2.0.0',
                integrity: depInteg,
                resolved: `${registry.origin}/dep.tgz`,
              },
            },
          },
        }),
        (registry) => {
          registry.setVersion('dep', '2.0.0', {
            name: 'dep',
            version: '2.0.0',
            dist: {
              integrity: depInteg,
              unpackedSize: 501 * 1024 * 1024,
            },
          });
        },
        'install_limit',
      );
    }, 30_000);

    it('refuses install_limit when fileCount > 50000', async () => {
      const depInteg = sha512Integrity('dep-integ');
      await assertRefusedAfterRunner(
        (registry, srvIntegrity) => ({
          lock: {
            lockfileVersion: 3,
            packages: {
              '': {},
              'node_modules/srv': {
                version: '1.0.0',
                integrity: srvIntegrity,
                resolved: `${registry.origin}/srv.tgz`,
              },
              'node_modules/dep': {
                version: '2.0.0',
                integrity: depInteg,
                resolved: `${registry.origin}/dep.tgz`,
              },
            },
          },
        }),
        (registry) => {
          registry.setVersion('dep', '2.0.0', {
            name: 'dep',
            version: '2.0.0',
            dist: {
              integrity: depInteg,
              fileCount: 50_001,
            },
          });
        },
        'install_limit',
      );
    }, 30_000);
  });

  // 12. Warnings
  describe('12. Warnings', () => {
    async function testWarning(options: {
      docOverrides?: Record<string, unknown>;
      packumentOverrides?: Record<string, unknown>;
      lockPackagesOverrides?:
        | Record<string, unknown>
        | ((
            registry: FixtureRegistry,
            srvInteg: string,
          ) => Record<string, unknown>);
      now?: () => Date;
      expectedWarnings: PackageWarning[];
      checkSizeNull?: boolean;
    }) {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvInteg = sha512Integrity('srv-warnings');

      const doc = {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dist: {
          integrity: srvInteg,
          unpackedSize: 1000,
          fileCount: 2,
        },
        engines: { node: '>=20' },
        ...options.docOverrides,
      };

      registry.setVersion('srv', '1.0.0', doc);

      if (options.packumentOverrides !== null) {
        registry.setPackage('srv', {
          name: 'srv',
          time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
          ...options.packumentOverrides,
        });
      }

      const extraLock =
        typeof options.lockPackagesOverrides === 'function'
          ? options.lockPackagesOverrides(registry, srvInteg)
          : (options.lockPackagesOverrides ?? {});

      const lockPackages: Record<string, unknown> = {
        '': {},
        'node_modules/srv': {
          version: '1.0.0',
          integrity: srvInteg,
          resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
          hasInstallScript: false,
        },
        ...extraLock,
      };

      const { runner } = createFakeRunner({
        lock: { lockfileVersion: 3, packages: lockPackages },
      });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      const preview = await resolvePackage({
        request: { name: 'srv', version: '1.0.0' },
        owner: 'test-owner',
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
        now: options.now ?? (() => new Date('2026-01-01T00:00:00.000Z')),
      });

      expect(preview.warnings).toEqual(options.expectedWarnings);
      if (options.checkSizeNull) {
        expect(preview.unpackedSize).toBeNull();
      }
    }

    it('emits install_scripts from lock hasInstallScript', async () => {
      await testWarning({
        lockPackagesOverrides: (registry, srvInteg) => ({
          'node_modules/srv': {
            version: '1.0.0',
            integrity: srvInteg,
            resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
            hasInstallScript: true,
          },
        }),
        expectedWarnings: ['install_scripts'],
      });
    });

    it('emits install_scripts from document scripts.postinstall', async () => {
      await testWarning({
        docOverrides: { scripts: { postinstall: 'node build.js' } },
        expectedWarnings: ['install_scripts'],
      });
    });

    it('emits install_scripts from document gypfile', async () => {
      await testWarning({
        docOverrides: { gypfile: true },
        expectedWarnings: ['install_scripts'],
      });
    });

    it('emits optional_omitted when optionalDependencies are present', async () => {
      await testWarning({
        docOverrides: { optionalDependencies: { opt: '^1.0.0' } },
        expectedWarnings: ['optional_omitted'],
      });
    });

    it('emits recent_release when released 1 day before fake now', async () => {
      await testWarning({
        packumentOverrides: { time: { '1.0.0': '2026-05-01T00:00:00.000Z' } },
        now: () => new Date('2026-05-02T00:00:00.000Z'),
        expectedWarnings: ['recent_release'],
      });
    });

    it('emits release_date_unknown when time is missing', async () => {
      await testWarning({
        packumentOverrides: { time: {} },
        expectedWarnings: ['release_date_unknown'],
      });
    });

    it('emits deprecated when document is deprecated', async () => {
      await testWarning({
        docOverrides: { deprecated: 'This package is deprecated' },
        expectedWarnings: ['deprecated'],
      });
    });

    it('emits engine_mismatch when engines.node is <1', async () => {
      await testWarning({
        docOverrides: { engines: { node: '<1' } },
        expectedWarnings: ['engine_mismatch'],
      });
    });

    it('emits many_packages when installed entries exceed 300', async () => {
      const extraPackages: Record<string, unknown> = {};
      const regOverrides: (r: FixtureRegistry) => void = (r) => {
        for (let i = 1; i <= 300; i++) {
          const name = `p${i}`;
          const integ = sha512Integrity(`dep-${i}`);
          extraPackages[`node_modules/${name}`] = {
            version: '1.0.0',
            integrity: integ,
            resolved: `${r.origin}/${name}/-/${name}-1.0.0.tgz`,
          };
          r.setVersion(name, '1.0.0', {
            name,
            version: '1.0.0',
            dist: { integrity: integ, unpackedSize: 10 },
          });
        }
      };

      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvInteg = sha512Integrity('srv-warnings');

      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dist: { integrity: srvInteg, unpackedSize: 1000 },
      });
      registry.setPackage('srv', {
        name: 'srv',
        time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
      });

      regOverrides(registry);

      const lockPackages: Record<string, unknown> = {
        '': {},
        'node_modules/srv': {
          version: '1.0.0',
          integrity: srvInteg,
          resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
        },
        ...extraPackages,
      };

      const { runner } = createFakeRunner({
        lock: { lockfileVersion: 3, packages: lockPackages },
      });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      const preview = await resolvePackage({
        request: { name: 'srv', version: '1.0.0' },
        owner: 'test-owner',
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(preview.packageCount).toBe(301);
      expect(preview.warnings).toEqual(['many_packages']);
    });

    it('emits large_size when unpackedSize exceeds 200 MiB', async () => {
      await testWarning({
        docOverrides: {
          dist: {
            integrity: sha512Integrity('srv-warnings'),
            unpackedSize: 201 * 1024 * 1024,
          },
        },
        expectedWarnings: ['large_size'],
      });
    });

    it('emits size_unknown when an entry is missing unpackedSize and sets preview.unpackedSize to null', async () => {
      await testWarning({
        docOverrides: {
          dist: {
            integrity: sha512Integrity('srv-warnings'),
          },
        },
        expectedWarnings: ['size_unknown'],
        checkSizeNull: true,
      });
    });

    it('combined case follows exact contract enum order', async () => {
      const extraPackages: Record<string, unknown> = {};
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvInteg = sha512Integrity('srv-combined-warning');

      for (let i = 1; i <= 300; i++) {
        const name = `p${i}`;
        const integ = sha512Integrity(`dep-${i}`);
        extraPackages[`node_modules/${name}`] = {
          version: '1.0.0',
          integrity: integ,
          resolved: `${registry.origin}/${name}/-/${name}-1.0.0.tgz`,
        };
        registry.setVersion(name, '1.0.0', {
          name,
          version: '1.0.0',
          dist: { integrity: integ, unpackedSize: 1000 },
        });
      }

      // Root doc triggers install_scripts, optional_omitted, deprecated, engine_mismatch, large_size, size_unknown
      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        scripts: { postinstall: 'node build.js' },
        optionalDependencies: { opt: '^1.0.0' },
        deprecated: 'deprecated warning',
        engines: { node: '<1' },
        dist: {
          integrity: srvInteg,
          // One package without unpackedSize will cause size_unknown
          unpackedSize: 205 * 1024 * 1024,
        },
      });

      // Override p1 to have no unpackedSize -> size_unknown
      const p1Integ = sha512Integrity('dep-1');
      registry.setVersion('p1', '1.0.0', {
        name: 'p1',
        version: '1.0.0',
        dist: { integrity: p1Integ },
      });

      // time triggers recent_release
      registry.setPackage('srv', {
        name: 'srv',
        time: { '1.0.0': '2026-05-01T00:00:00.000Z' },
      });

      const lockPackages: Record<string, unknown> = {
        '': {},
        'node_modules/srv': {
          version: '1.0.0',
          integrity: srvInteg,
          resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
        },
        ...extraPackages,
      };

      const { runner } = createFakeRunner({
        lock: { lockfileVersion: 3, packages: lockPackages },
      });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      const preview = await resolvePackage({
        request: { name: 'srv', version: '1.0.0' },
        owner: 'test-owner',
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
        now: () => new Date('2026-05-02T00:00:00.000Z'),
      });

      expect(preview.warnings).toEqual([
        'install_scripts',
        'optional_omitted',
        'recent_release',
        'deprecated',
        'engine_mismatch',
        'many_packages',
        'large_size',
        'size_unknown',
      ]);
    });
  });

  // 13. No leak
  describe('13. No leak', () => {
    it('ensures PackageFault.message leaks no bodies, stdout/stderr, temp paths, or CA', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const SECRET_MARKER = 'SENTINEL_TOKEN_SECRET_987654321';
      const SECRET_STDOUT = 'SECRET_RUNNER_STDOUT_ABCDEFG';
      const SECRET_STDERR = 'SECRET_RUNNER_STDERR_HIJKLMN';

      // Plant secret marker into registry response
      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        description: SECRET_MARKER,
        bin: { srv: 'bin/srv.js' },
        dist: { integrity: sha512Integrity('srv-tarball') },
      });

      const { runner } = createFakeRunner({
        outcome: 'exited',
        exitCode: 1,
        stdout: SECRET_STDOUT,
        stderr: SECRET_STDERR,
      });

      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      let caughtError: unknown;
      try {
        await resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          runner,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(PackageFault);
      const msg = (caughtError as PackageFault).message;

      expect(msg).toBe('Package operation failed.');
      expect(msg).not.toContain(SECRET_MARKER);
      expect(msg).not.toContain(SECRET_STDOUT);
      expect(msg).not.toContain(SECRET_STDERR);
      expect(msg).not.toContain(packagesDir);
      expect(msg).not.toContain(registry.ca);
    });
  });

  // 14. AbortController aborted before call
  describe('14. AbortController aborted before call', () => {
    it('gives cancelled and leaves no job folder', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const controller = new AbortController();
      controller.abort();

      const { runner, calls } = createFakeRunner();
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      await expect(
        resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner',
          packagesDir,
          signal: controller.signal,
          previews,
          registry: registry.registry,
          runner,
        }),
      ).rejects.toMatchObject({ code: 'cancelled' });

      expect(calls).toHaveLength(0);

      const jobsFolder = join(packagesDir, '.jobs');
      try {
        const entries = await readdir(jobsFolder);
        expect(entries).toHaveLength(0);
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });
  });

  // 15. Real end-to-end run
  describe('15. Real end-to-end run with bundled npm', () => {
    it.skipIf(process.platform !== 'win32')(
      'resolves srv@1.0.0 with real bundled npm runner through allow-list proxy',
      async () => {
        const tempDir = await createTempDir();
        const packagesDir = join(tempDir, 'packages');
        await mkdir(packagesDir, { recursive: true });

        const registry = await createRegistry();

        // Build a real tarball for srv@1.0.0 using npm's bundled tar
        const tarball = await createSimpleTarball(
          {
            'package.json': JSON.stringify({
              name: 'srv',
              version: '1.0.0',
              bin: { srv: 'bin/srv.js' },
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
              dist: { integrity, tarball: tarballUrl },
            },
          },
          time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        });

        const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

        // runner is omitted: real Windows runner and process.execPath are used!
        const relayed: number[] = [];
        const preview = await resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner-e2e',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          onProgress: (progress) => relayed.push(progress.downloadedBytes),
        });

        expect(preview.name).toBe('srv');
        expect(preview.version).toBe('1.0.0');
        expect(preview.packageCount).toBe(1);

        // The fixture saw the requests, and the allow-list proxy relayed the
        // bytes of the npm run: a run that reached the registry directly
        // would leave the proxy's count at zero.
        const reqs = registry.requests();
        expect(reqs.length).toBeGreaterThan(0);
        expect(Math.max(0, ...relayed)).toBeGreaterThan(0);
      },
      120_000,
    );
  });

  // 15b. The real npm and an ancestor .npmrc
  describe('15b. The real npm and an ancestor .npmrc', () => {
    it.skipIf(process.platform !== 'win32')(
      'resolves against the fixture registry although an ancestor .npmrc names another registry',
      async () => {
        const tempDir = await createTempDir();
        const packagesDir = join(tempDir, 'packages');
        await mkdir(packagesDir, { recursive: true });

        const registry = await createRegistry();

        // The .npmrc of the user: npm never reads it, because every npm run
        // of the hub names its own configuration files.
        const sentinelHost = 'sentinel-npmrc.invalid';
        await writeFile(
          join(tempDir, '.npmrc'),
          `registry=https://${sentinelHost}/\n`,
          'utf8',
        );

        const tarball = await createSimpleTarball(
          {
            'package.json': JSON.stringify({
              name: 'srv',
              version: '1.0.0',
              bin: { srv: 'bin/srv.js' },
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
              dist: { integrity, tarball: tarballUrl },
            },
          },
          time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        });

        const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

        // runner is omitted: the real Windows runner and the real npm run.
        const preview = await resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner-npmrc',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
        });

        expect(preview.name).toBe('srv');
        expect(preview.version).toBe('1.0.0');
        expect(preview.packageCount).toBe(1);

        // The proxy never saw the host of the ancestor .npmrc: such an attempt
        // would have ended the lookup with "foreign_host".
        for (const request of registry.requests())
          expect(request).not.toContain(sentinelHost);

        // The sentinel never reaches the output of the lookup, the preview or
        // the stored job record.
        expect(JSON.stringify(preview)).not.toContain(sentinelHost);
        const record = await previews.take(
          preview.previewId,
          'test-owner-npmrc',
        );
        expect(JSON.stringify(record.preview)).not.toContain(sentinelHost);
        expect(Buffer.from(record.lock).toString('utf8')).not.toContain(
          sentinelHost,
        );

        // The npm run used the configuration files of the job, not the ones
        // of the ancestor.
        const jobFolder = jobDirectory(packagesDir, record.jobId);
        expect(await readFile(join(jobFolder, 'user.npmrc'), 'utf8')).toBe('');
        expect(await readFile(join(jobFolder, 'global.npmrc'), 'utf8')).toBe(
          '',
        );
      },
      120_000,
    );
  });

  // 16. Bounded lookup
  describe('16. Bounded lookup', () => {
    it('refuses install_limit for a tree of 2001 packages without fetching a version document', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-wide');
      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dist: { integrity: srvIntegrity, unpackedSize: 1000, fileCount: 1 },
      });

      // The root and 2000 dependencies: one package too many.
      const lockPackages: Record<string, unknown> = {
        '': { name: 'staging', version: '1.0.0' },
        'node_modules/srv': {
          version: '1.0.0',
          integrity: srvIntegrity,
          resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
        },
      };
      for (let index = 0; index < 2000; index++) {
        lockPackages[`node_modules/wide${index}`] = {
          version: '1.0.0',
          integrity: sha512Integrity(`wide-${index}`),
          resolved: `${registry.origin}/wide${index}/-/wide${index}-1.0.0.tgz`,
        };
      }

      const { runner } = createFakeRunner({
        lock: { lockfileVersion: 3, packages: lockPackages },
      });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      await expect(
        resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_limit' });

      // Not a single version document of a dependency was fetched.
      const documents = registry
        .requests()
        .filter((url) => /^\/wide\d+\/1\.0\.0$/.test(url));
      expect(documents).toHaveLength(0);
    }, 60_000);

    it('counts bundled copies toward the package cap', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-bundled-wide');
      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dist: { integrity: srvIntegrity, unpackedSize: 1000, fileCount: 1 },
      });

      // The root, 1000 dependencies and 1000 bundled copies: 2001 packages.
      const lockPackages: Record<string, unknown> = {
        '': { name: 'staging', version: '1.0.0' },
        'node_modules/srv': {
          version: '1.0.0',
          integrity: srvIntegrity,
          resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
        },
      };
      for (let index = 0; index < 1000; index++) {
        lockPackages[`node_modules/wide${index}`] = {
          version: '1.0.0',
          integrity: sha512Integrity(`bundled-wide-${index}`),
          resolved: `${registry.origin}/wide${index}/-/wide${index}-1.0.0.tgz`,
        };
        lockPackages[`node_modules/wide${index}/node_modules/inner`] = {
          version: '1.0.0',
          inBundle: true,
        };
      }

      const { runner } = createFakeRunner({
        lock: { lockfileVersion: 3, packages: lockPackages },
      });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      await expect(
        resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_limit' });
      const documents = registry
        .requests()
        .filter((url) => /^\/wide\d+\/1\.0\.0$/.test(url));
      expect(documents).toHaveLength(0);
    }, 60_000);

    it('warns about the scripts of a bundled copy', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-bundled');
      const depIntegrity = sha512Integrity('dep-bundled');
      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dependencies: { dep: '^2.0.0' },
        dist: { integrity: srvIntegrity, unpackedSize: 1000, fileCount: 5 },
      });
      registry.setVersion('dep', '2.1.0', {
        name: 'dep',
        version: '2.1.0',
        bundleDependencies: ['inner'],
        dist: { integrity: depIntegrity, unpackedSize: 2000, fileCount: 10 },
      });
      const lockFor = (inner: Record<string, unknown>) => ({
        name: 'staging',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'staging', version: '1.0.0' },
          'node_modules/srv': {
            version: '1.0.0',
            integrity: srvIntegrity,
            resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
            hasInstallScript: false,
          },
          'node_modules/dep': {
            version: '2.1.0',
            integrity: depIntegrity,
            resolved: `${registry.origin}/dep/-/dep-2.1.0.tgz`,
            hasInstallScript: false,
          },
          'node_modules/dep/node_modules/inner': {
            version: '0.1.0',
            inBundle: true,
            ...inner,
          },
        },
      });
      const lookUp = async (inner: Record<string, unknown>) => {
        const { runner } = createFakeRunner({ lock: lockFor(inner) });
        const previews = trackPreviewStore(createPreviewStore({ packagesDir }));
        return resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          runner,
          now: () => new Date('2026-01-01T00:00:00.000Z'),
        });
      };

      // Nothing tells whether the bundled copy runs a script.
      const unknown = await lookUp({});
      expect(unknown.bundledCount).toBe(1);
      expect(unknown.warnings).toContain('install_scripts_unknown');
      expect(unknown.warnings).not.toContain('install_scripts');

      // The lock says it does.
      const known = await lookUp({ hasInstallScript: true });
      expect(known.warnings).toContain('install_scripts');
      expect(known.warnings).not.toContain('install_scripts_unknown');
    }, 60_000);

    it('stops fetching version documents when the running unpacked size passes the cap', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-size');
      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        bin: { srv: 'bin/srv.js' },
        dist: { integrity: srvIntegrity, unpackedSize: 1000, fileCount: 1 },
      });

      // 200 packages of 10 MiB: the cap of 500 MiB is passed after 50 of them.
      const count = 200;
      const lockPackages: Record<string, unknown> = {
        '': { name: 'staging', version: '1.0.0' },
        'node_modules/srv': {
          version: '1.0.0',
          integrity: srvIntegrity,
          resolved: `${registry.origin}/srv/-/srv-1.0.0.tgz`,
        },
      };
      for (let index = 0; index < count; index++) {
        const name = `big${index}`;
        const integrity = sha512Integrity(`big-${index}`);
        lockPackages[`node_modules/${name}`] = {
          version: '1.0.0',
          integrity,
          resolved: `${registry.origin}/${name}/-/${name}-1.0.0.tgz`,
        };
        registry.setVersion(name, '1.0.0', {
          name,
          version: '1.0.0',
          dist: { integrity, unpackedSize: 10 * 1024 * 1024, fileCount: 1 },
        });
      }

      const { runner } = createFakeRunner({
        lock: { lockfileVersion: 3, packages: lockPackages },
      });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      await expect(
        resolvePackage({
          request: { name: 'srv', version: '1.0.0' },
          owner: 'test-owner',
          packagesDir,
          signal: new AbortController().signal,
          previews,
          registry: registry.registry,
          runner,
        }),
      ).rejects.toMatchObject({ code: 'install_limit' });

      // The lookup stopped long before the last package of the tree.
      const documents = registry
        .requests()
        .filter((url) => /^\/big\d+\/1\.0\.0$/.test(url));
      expect(documents.length).toBeLessThan(count);
      expect(documents.length).toBeLessThan(100);
    }, 60_000);

    it('keeps the preview and the warnings of an ordinary tree identical', async () => {
      const tempDir = await createTempDir();
      const packagesDir = join(tempDir, 'packages');
      await mkdir(packagesDir, { recursive: true });

      const registry = await createRegistry();
      const srvIntegrity = sha512Integrity('srv-ordinary');
      const depIntegrity = sha512Integrity('dep-ordinary');

      registry.setVersion('srv', '1.0.0', {
        name: 'srv',
        version: '1.0.0',
        description: 'An ordinary package',
        bin: { srv: 'bin/srv.js' },
        scripts: { postinstall: 'node build.js' },
        dependencies: { dep: '^2.0.0' },
        optionalDependencies: { opt: '^1.0.0' },
        dist: { integrity: srvIntegrity, unpackedSize: 1000, fileCount: 5 },
      });
      registry.setVersion('dep', '2.1.0', {
        name: 'dep',
        version: '2.1.0',
        gypfile: true,
        dist: { integrity: depIntegrity, unpackedSize: 2000, fileCount: 10 },
      });

      const lockObject = {
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
          'node_modules/dep': {
            version: '2.1.0',
            integrity: depIntegrity,
            resolved: `${registry.origin}/dep/-/dep-2.1.0.tgz`,
            hasInstallScript: true,
          },
        },
      };
      const lockBytes = Buffer.from(
        JSON.stringify(lockObject, null, 2),
        'utf8',
      );

      const { runner } = createFakeRunner({ lock: lockObject });
      const previews = trackPreviewStore(createPreviewStore({ packagesDir }));

      const preview = await resolvePackage({
        request: { name: 'srv', version: '1.0.0' },
        owner: 'test-owner',
        packagesDir,
        signal: new AbortController().signal,
        previews,
        registry: registry.registry,
        runner,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(preview.name).toBe('srv');
      expect(preview.version).toBe('1.0.0');
      expect(preview.description).toBe('An ordinary package');
      expect(preview.integrity).toBe(srvIntegrity);
      expect(preview.lockHash).toBe(
        createHash('sha256').update(lockBytes).digest('hex'),
      );
      expect(preview.packageCount).toBe(2);
      expect(preview.bundledCount).toBe(0);
      expect(preview.unpackedSize).toBe(3000);
      expect(preview.releasedAt).toBeNull();
      expect(preview.entries).toEqual([
        { entry: 'srv', entryPath: 'bin/srv.js' },
      ]);
      expect(preview.warnings).toEqual([
        'install_scripts',
        'optional_omitted',
        'release_date_unknown',
      ]);
    });
  });

  // 17. The real self-test of the bundled npm
  describe('17. The bundled npm', () => {
    it.skipIf(process.platform !== 'win32')(
      'passes the npm self-test against the bundled npm',
      async () => {
        const tempDir = await createTempDir();
        const packagesDir = join(tempDir, 'packages');
        await mkdir(packagesDir, { recursive: true });

        const registry = await createRegistry();
        const paths = await prepareJob(
          packagesDir,
          randomUUID(),
          registry.registry,
        );
        try {
          await npmSelfTest({
            paths,
            registry: registry.registry,
            signal: AbortSignal.timeout(60_000),
            nodeExecutable: process.execPath,
          });
        } finally {
          await removeTree(paths.root, packagesDir).catch(() => false);
        }
      },
      120_000,
    );
  });
});
