import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { dirname, join } from 'node:path';
import type {
  HubLifecycle,
  PackageService,
  StateStore,
} from '@waleed/hub-core';
import type { PackageJob } from '@waleed/contracts';
import { createLifecycle, createMemorySafetyLedger } from '@waleed/hub-core';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../packages/hub-core/src/ports.js';
import {
  installDirectory,
  markerPath,
} from '../packages/hub-core/src/packages/store.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';
import {
  createFixtureRegistry,
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

      if (isLock && options.onLock) {
        const res = await options.onLock(call);
        if (res) return res;
      }
      if (isCi && options.onCi) {
        const res = await options.onCi(call);
        if (res) return res;
      }

      if (isCi && prefixDir) {
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

function seedPackage(
  registry: FixtureRegistry,
  options: {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  } = {},
) {
  const name = options.name ?? 'srv';
  const version = options.version ?? '1.0.0';
  const bin = options.bin ?? { srv: 'bin/srv.js' };
  const srvIntegrity = sha512Integrity(`srv-${version}-bytes`);
  const tarballUrl = `${registry.origin}/${name}/-/${name}-${version}.tgz`;

  registry.setVersion(name, version, {
    name,
    version,
    bin,
    scripts: options.scripts,
    dependencies: options.dependencies,
    dist: {
      integrity: srvIntegrity,
      tarball: tarballUrl,
      unpackedSize: 1000,
      fileCount: 5,
    },
  });

  registry.setPackage(name, {
    name,
    'dist-tags': { latest: version },
    time: { [version]: '2026-01-01T00:00:00.000Z' },
  });

  const lock = {
    name: 'staging',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'staging', version: '1.0.0' },
      [`node_modules/${name}`]: {
        version,
        integrity: srvIntegrity,
        resolved: tarballUrl,
        ...(options.scripts?.postinstall ? { hasInstallScript: true } : {}),
      },
    },
  };

  return { name, version, bin, integrity: srvIntegrity, lock };
}

async function waitFor(
  service: PackageService,
  job: { id: string },
  owner = 'owner-a',
): Promise<PackageJob> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = service.job(job.id, owner);
    if (current.completedAt) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${job.id} timed out waiting for completion`);
}

describe('package-service', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  const lifecycles: HubLifecycle[] = [];
  const registries: FixtureRegistry[] = [];
  const secretBackends: ReturnType<typeof memorySecrets>[] = [];
  let sharedTls: TestTls;

  beforeAll(async () => {
    sharedTls = await createTestTls();
  });

  afterAll(async () => {
    if (sharedTls) await sharedTls.dispose();
  });

  afterEach(async () => {
    while (lifecycles.length > 0) {
      const lc = lifecycles.pop();
      if (lc) await lc.close().catch(() => undefined);
    }
    while (registries.length > 0) {
      const reg = registries.pop();
      if (reg) await reg.close().catch(() => undefined);
    }
    while (secretBackends.length > 0) {
      const sec = secretBackends.pop();
      if (sec) sec.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  async function setupService(
    options: {
      store?: StateStore;
      runnerOptions?: FakeProcessRunnerOptions;
      now?: () => number;
      secretBackend?: ReturnType<typeof memorySecrets>;
      packageConfig?: {
        name?: string;
        version?: string;
        bin?: Record<string, string>;
        scripts?: Record<string, string>;
      };
    } = {},
  ) {
    const tempBase = await mkdtemp(join(tmpdir(), 'wmh-svc-'));
    tempDirs.push(tempBase);
    const packagesDir = join(tempBase, 'packages');
    await mkdir(packagesDir, { recursive: true });

    const registry = await createFixtureRegistry({ tls: sharedTls });
    registries.push(registry);

    const seeded = seedPackage(registry, options.packageConfig);

    const fakeRunner = createFakeRunner({
      lock: seeded.lock,
      defaultBin: seeded.bin,
      ...options.runnerOptions,
    });

    const store = options.store ?? memoryStore();
    const safety = createMemorySafetyLedger();
    const secrets = options.secretBackend ?? memorySecrets();
    secretBackends.push(secrets);

    const lifecycle = createLifecycle(store, Date.now, safety, {
      secrets: { windows: secrets.backend, docker: secrets.backend },
      packages: {
        packagesDir,
        nodeExecutable: process.execPath,
        registry: registry.registry,
        runner: fakeRunner.runner,
        ...(options.now ? { now: options.now } : {}),
      },
    });
    lifecycles.push(lifecycle);

    const service = lifecycle.packages!;
    return {
      lifecycle,
      service,
      packagesDir,
      registry,
      seeded,
      fakeRunner,
      store,
      secrets,
    };
  }

  it('1. Look up', async () => {
    const { service } = await setupService();

    const job = service.resolve({ name: 'srv', version: '1.0.0' }, 'owner-a');
    expect(job.kind).toBe('resolve');
    expect(job.state).toBe('running');
    expect(job.phase).toBe('resolving');
    expect(service.activeJobs().has(job.id)).toBe(true);

    const completed = await waitFor(service, job, 'owner-a');
    expect(completed.state).toBe('succeeded');
    expect(completed.phase).toBe('complete');
    expect(completed.preview).toBeDefined();
    expect(completed.preview?.name).toBe('srv');
    expect(completed.preview?.version).toBe('1.0.0');
    expect(service.activeJobs().has(job.id)).toBe(true);
  });

  it('2. Install, saved', async () => {
    const { service, lifecycle, packagesDir } = await setupService();

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installPayload = {
      previewId: preview.previewId,
      entry: preview.entries[0]!.entry,
      acknowledgedWarnings: preview.warnings,
      connectorName: 'Srv',
      arguments: ['--flag'],
      env: { API_TOKEN: 'sentinel-value-123' },
    };

    const installJob = await service.install(installPayload, 'owner-a');
    const completed = await waitFor(service, installJob, 'owner-a');

    expect(completed.state).toBe('succeeded');
    expect(completed.result).toEqual({
      connectorId: expect.any(String),
      outcome: 'saved',
    });

    const state = await lifecycle.inventory();
    const connector = state.connectors.find(
      (c) => c.id === completed.result!.connectorId,
    );
    expect(connector).toBeDefined();
    expect(connector?.executionMode).toBe('native');
    if (connector?.executionMode !== 'native') {
      throw new Error('Expected native connector');
    }
    expect(connector.package).toBeDefined();
    expect(connector.executable).toBe(process.execPath);
    expect(connector.arguments[0]).toBe('--no-global-search-paths');
    expect(connector.arguments[2]).toBe('--flag');
    expect(connector.secretBindings['API_TOKEN']).toBeDefined();
    expect(connector.trustApproval).toBeNull();

    const installDir = installDirectory(
      packagesDir,
      connector.package!.installId,
    );
    const marker = markerPath(packagesDir, connector.package!.installId);
    expect(await pathExists(installDir)).toBe(true);
    expect(await pathExists(marker)).toBe(false);

    expect(JSON.stringify(installJob)).not.toContain('sentinel-value-123');
    expect(JSON.stringify(completed)).not.toContain('sentinel-value-123');
    expect(JSON.stringify(state)).not.toContain('sentinel-value-123');

    const verifyResult = await service.verify(connector!.id);
    expect(verifyResult).toEqual({
      connectorId: connector!.id,
      result: 'verified',
    });
  });

  it('3. Verify detects tampering', async () => {
    const { service, lifecycle } = await setupService();

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'SrvTamper',
        arguments: ['--flag'],
        env: { API_TOKEN: 'sentinel-value-123' },
      },
      'owner-a',
    );
    const completed = await waitFor(service, installJob, 'owner-a');
    const state = await lifecycle.inventory();
    const managedConnector = state.connectors.find(
      (c) => c.id === completed.result!.connectorId,
    );
    expect(managedConnector).toBeDefined();
    expect(managedConnector?.executionMode).toBe('native');
    if (managedConnector?.executionMode !== 'native') {
      throw new Error('Expected native connector');
    }

    // Append a byte to the entry file
    await writeFile(managedConnector.arguments[1]!, 'X', { flag: 'a' });
    const tamperedResult = await service.verify(managedConnector.id);
    expect(tamperedResult).toEqual({
      connectorId: managedConnector.id,
      result: 'package_modified',
    });

    // Unknown id rejects with not_found
    await expect(service.verify('unknown-id-123')).rejects.toMatchObject({
      code: 'not_found',
    });

    // Ordinary native connector rejects with invalid
    const plainNativeDef = {
      id: 'plain-native-conn',
      name: 'PlainNative',
      description: '',
      enabled: true,
      environmentLiterals: {},
      secretBindings: {},
      headerBindings: {},
      trustApproval: null,
      executionMode: 'native' as const,
      transport: 'stdio' as const,
      executable: process.execPath,
      arguments: ['fixture.js'],
    };
    const p = await lifecycle.preview(
      {
        kind: 'create_connector',
        expectedRevision: (await lifecycle.inventory()).revision,
        definition: plainNativeDef,
      },
      'owner-a',
    );
    await lifecycle.apply(p.id, 'owner-a');
    await lifecycle.drain();

    await expect(service.verify('plain-native-conn')).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('4. Preview refusals', async () => {
    let controlledTime = 1_000_000;
    const { service } = await setupService({
      now: () => controlledTime,
    });

    // Case 4a: a second install with the same previewId
    const resolveJob1 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved1 = await waitFor(service, resolveJob1, 'owner-a');
    const preview1 = resolved1.preview!;

    const install1 = await service.install(
      {
        previewId: preview1.previewId,
        entry: preview1.entries[0]!.entry,
        acknowledgedWarnings: preview1.warnings,
        connectorName: 'Srv-1',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completed1 = await waitFor(service, install1, 'owner-a');
    expect(completed1.state).toBe('succeeded');

    const installSecond = await service.install(
      {
        previewId: preview1.previewId,
        entry: preview1.entries[0]!.entry,
        acknowledgedWarnings: preview1.warnings,
        connectorName: 'Srv-1-Second',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completedSecond = await waitFor(service, installSecond, 'owner-a');
    expect(completedSecond.state).toBe('failed');
    expect(completedSecond.error).toBe('preview_expired');

    // Case 4b: an install by 'owner-b' with owner-a's previewId (and owner-a can still install afterwards)
    const resolveJob2 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved2 = await waitFor(service, resolveJob2, 'owner-a');
    const preview2 = resolved2.preview!;

    const installByB = await service.install(
      {
        previewId: preview2.previewId,
        entry: preview2.entries[0]!.entry,
        acknowledgedWarnings: preview2.warnings,
        connectorName: 'Srv-B',
        arguments: [],
        env: {},
      },
      'owner-b',
    );
    const completedByB = await waitFor(service, installByB, 'owner-b');
    expect(completedByB.state).toBe('failed');
    expect(completedByB.error).toBe('preview_expired');

    const installAfterByA = await service.install(
      {
        previewId: preview2.previewId,
        entry: preview2.entries[0]!.entry,
        acknowledgedWarnings: preview2.warnings,
        connectorName: 'Srv-A-After',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completedAfterByA = await waitFor(
      service,
      installAfterByA,
      'owner-a',
    );
    expect(completedAfterByA.state).toBe('succeeded');

    // Case 4c: an install after the preview TTL
    const resolveJob3 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved3 = await waitFor(service, resolveJob3, 'owner-a');
    const preview3 = resolved3.preview!;

    // TTL is 600_000 ms. Advance time past TTL
    controlledTime += 600_001;

    const installAfterTTL = await service.install(
      {
        previewId: preview3.previewId,
        entry: preview3.entries[0]!.entry,
        acknowledgedWarnings: preview3.warnings,
        connectorName: 'Srv-TTL',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completedAfterTTL = await waitFor(
      service,
      installAfterTTL,
      'owner-a',
    );
    expect(completedAfterTTL.state).toBe('failed');
    expect(completedAfterTTL.error).toBe('preview_expired');
  });

  it('5. Unacknowledged warning', async () => {
    const { service, fakeRunner } = await setupService({
      packageConfig: {
        scripts: { postinstall: 'node postinstall.js' },
      },
    });

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;
    expect(preview.warnings).toContain('install_scripts');

    const initialCiCalls = fakeRunner.calls.filter(
      (c) => c.command === 'ci',
    ).length;
    expect(initialCiCalls).toBe(0);

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: [],
        connectorName: 'SrvWarning',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completed = await waitFor(service, installJob, 'owner-a');
    expect(completed.state).toBe('failed');
    expect(completed.error).toBe('warning_not_acknowledged');

    const finalCiCalls = fakeRunner.calls.filter(
      (c) => c.command === 'ci',
    ).length;
    expect(finalCiCalls).toBe(0);
  });

  it('6. Synchronous refusals', async () => {
    let releaseCi!: () => void;
    const ciHold = new Promise<void>((resolve) => {
      releaseCi = resolve;
    });

    let releaseLock!: () => void;
    const lockHold = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const { service } = await setupService({
      runnerOptions: {
        onCi: async (call) => {
          if (call.request.arguments[1] === 'ci') {
            await ciHold;
          }
        },
        onLock: async () => {
          await lockHold;
        },
      },
    });

    // Pre-resolve previews while lockHold is released for these initial setups
    releaseLock();

    const resolve1 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const prev1 = (await waitFor(service, resolve1, 'owner-a')).preview!;

    const resolve2 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const prev2 = (await waitFor(service, resolve2, 'owner-a')).preview!;

    // 6a: a second install while the first is still running -> busy
    const install1 = await service.install(
      {
        previewId: prev1.previewId,
        entry: prev1.entries[0]!.entry,
        acknowledgedWarnings: prev1.warnings,
        connectorName: 'Running-1',
        arguments: [],
        env: {},
      },
      'owner-a',
    );

    await expect(
      service.install(
        {
          previewId: prev2.previewId,
          entry: prev2.entries[0]!.entry,
          acknowledgedWarnings: prev2.warnings,
          connectorName: 'Running-2',
          arguments: [],
          env: {},
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'busy' });

    // Release the first install
    releaseCi();
    const completed1 = await waitFor(service, install1, 'owner-a');
    expect(completed1.state).toBe('succeeded');

    // The second preview was not consumed - a following correct install succeeds
    const install2 = await service.install(
      {
        previewId: prev2.previewId,
        entry: prev2.entries[0]!.entry,
        acknowledgedWarnings: prev2.warnings,
        connectorName: 'Running-2',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completed2 = await waitFor(service, install2, 'owner-a');
    expect(completed2.state).toBe('succeeded');

    // 6b: a connector name that already exists -> conflict
    const resolve3 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const prev3 = (await waitFor(service, resolve3, 'owner-a')).preview!;

    await expect(
      service.install(
        {
          previewId: prev3.previewId,
          entry: prev3.entries[0]!.entry,
          acknowledgedWarnings: prev3.warnings,
          connectorName: 'Running-1', // already exists
          arguments: [],
          env: {},
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Preview 3 not consumed; installing with a non-conflicting name succeeds
    const install3 = await service.install(
      {
        previewId: prev3.previewId,
        entry: prev3.entries[0]!.entry,
        acknowledgedWarnings: prev3.warnings,
        connectorName: 'Running-3-Unique',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completed3 = await waitFor(service, install3, 'owner-a');
    expect(completed3.state).toBe('succeeded');

    // 6c: 17 env names -> invalid
    const resolve4 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const prev4 = (await waitFor(service, resolve4, 'owner-a')).preview!;

    const env17 = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`VAR_${i}`, `secret-token-${i}`]),
    );

    await expect(
      service.install(
        {
          previewId: prev4.previewId,
          entry: prev4.entries[0]!.entry,
          acknowledgedWarnings: prev4.warnings,
          connectorName: 'Running-4',
          arguments: [],
          env: env17,
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'invalid' });

    // Preview 4 not consumed; install with valid env succeeds
    const install4 = await service.install(
      {
        previewId: prev4.previewId,
        entry: prev4.entries[0]!.entry,
        acknowledgedWarnings: prev4.warnings,
        connectorName: 'Running-4',
        arguments: [],
        env: { VALID_VAR: 'clean-secret-token-4' },
      },
      'owner-a',
    );
    const completed4 = await waitFor(service, install4, 'owner-a');
    expect(completed4.state).toBe('succeeded');

    // 6d: an env value that also appears in arguments -> invalid
    const resolve5 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const prev5 = (await waitFor(service, resolve5, 'owner-a')).preview!;

    const secretEchoValue = 'my-super-secret-echo-val';
    await expect(
      service.install(
        {
          previewId: prev5.previewId,
          entry: prev5.entries[0]!.entry,
          acknowledgedWarnings: prev5.warnings,
          connectorName: 'Running-5',
          arguments: [`--custom-flag=${secretEchoValue}`],
          env: { TOKEN: secretEchoValue },
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'invalid' });

    // Preview 5 not consumed; install with clean arguments succeeds
    const install5 = await service.install(
      {
        previewId: prev5.previewId,
        entry: prev5.entries[0]!.entry,
        acknowledgedWarnings: prev5.warnings,
        connectorName: 'Running-5',
        arguments: ['--clean-flag'],
        env: { TOKEN: secretEchoValue },
      },
      'owner-a',
    );
    const completed5 = await waitFor(service, install5, 'owner-a');
    expect(completed5.state).toBe('succeeded');

    // 6e: a third concurrent resolve -> busy
    let releaseHold2!: () => void;
    const lockHold2 = new Promise<void>((resolve) => {
      releaseHold2 = resolve;
    });

    const { service: lookupService } = await setupService({
      runnerOptions: {
        onLock: async () => {
          await lockHold2;
        },
      },
    });

    const r1 = lookupService.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const r2 = lookupService.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );

    expect(() =>
      lookupService.resolve({ name: 'srv', version: '1.0.0' }, 'owner-a'),
    ).toThrow(expect.objectContaining({ code: 'busy' }));

    releaseHold2();
    await waitFor(lookupService, r1, 'owner-a');
    await waitFor(lookupService, r2, 'owner-a');
  });

  it('7. Ownership', async () => {
    const { service } = await setupService();

    const job = service.resolve({ name: 'srv', version: '1.0.0' }, 'owner-a');

    expect(() => service.job(job.id, 'owner-b')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect(() => service.cancel(job.id, 'owner-b')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );

    await waitFor(service, job, 'owner-a');
  });

  it('8. Cancel while precommit', async () => {
    let installFolderExistedWhenExiting = false;

    const { service, lifecycle, packagesDir } = await setupService({
      runnerOptions: {
        onCi: async (call) => {
          const prefixDir = call.prefixDir!;
          await mkdir(join(prefixDir, 'node_modules', 'srv'), {
            recursive: true,
          });

          await new Promise<void>((resolve) => {
            if (call.request.signal.aborted) return resolve();
            call.request.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });

          await new Promise((resolve) => setTimeout(resolve, 300));
          installFolderExistedWhenExiting = await pathExists(prefixDir);
          return {
            outcome: 'cancelled',
            exitCode: null,
            stdout: '',
            stderr: '',
          };
        },
      },
    });

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'CancelPkg',
        arguments: [],
        env: {},
      },
      'owner-a',
    );

    while (service.job(installJob.id, 'owner-a').phase !== 'downloading') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const cancelSnapshot = service.cancel(installJob.id, 'owner-a');
    expect(cancelSnapshot.state).not.toBe('cancelled');

    const completed = await waitFor(service, installJob, 'owner-a');
    expect(completed.state).toBe('cancelled');
    expect(completed.error).toBe('cancelled');
    expect(installFolderExistedWhenExiting).toBe(true);

    const remaining = await readdir(packagesDir);
    expect(remaining.filter((f) => f.endsWith('.installing'))).toHaveLength(0);
    const subdirs = (
      await readdir(packagesDir, { withFileTypes: true })
    ).filter((d) => d.isDirectory() && d.name !== '.jobs');
    expect(subdirs).toHaveLength(0);

    const jobsFolder = join(packagesDir, '.jobs');
    if (await pathExists(jobsFolder)) {
      const jobsRemaining = await readdir(jobsFolder);
      expect(jobsRemaining).toHaveLength(0);
    }

    const inv = await lifecycle.inventory();
    expect(inv.connectors).toHaveLength(0);
  });

  it('9. Cancel while committing is refused', async () => {
    let saveEntered = false;
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });

    const baseStore = memoryStore();
    const wrappedStore: StateStore = {
      ...baseStore,
      async write(expectedRevision, next) {
        if (next.connectors.length > 0) {
          saveEntered = true;
          await saveGate;
        }
        return baseStore.write(expectedRevision, next);
      },
    };

    const { service } = await setupService({ store: wrappedStore });

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'BlockSavePkg',
        arguments: [],
        env: {},
      },
      'owner-a',
    );

    while (!(
      service.job(installJob.id, 'owner-a').phase === 'saving' && saveEntered
    )) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(() => service.cancel(installJob.id, 'owner-a')).toThrow(
      expect.objectContaining({ code: 'busy' }),
    );

    releaseSave();

    const completed = await waitFor(service, installJob, 'owner-a');
    expect(completed.state).toBe('succeeded');
  });

  it('10. save_uncertain', async () => {
    const baseStore = memoryStore();
    let failSave = false;
    const wrappedStore: StateStore = {
      async read() {
        if (failSave) throw new Error('Injected read failure');
        return baseStore.read();
      },
      async write(expectedRevision, next) {
        if (next.connectors.length > 0) {
          await baseStore.write(expectedRevision, next);
          failSave = true;
          throw new Error('Injected write failure');
        }
        return baseStore.write(expectedRevision, next);
      },
      async close() {
        return baseStore.close();
      },
    };

    const { service, packagesDir } = await setupService({
      store: wrappedStore,
    });

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'UncertainPkg',
        arguments: [],
        env: {},
      },
      'owner-a',
    );

    const completed = await waitFor(service, installJob, 'owner-a');
    expect(completed.state).toBe('failed');
    expect(completed.error).toBe('save_uncertain');

    const entries = await readdir(packagesDir, { withFileTypes: true });
    const installDirs = entries.filter(
      (e) => e.isDirectory() && e.name !== '.jobs',
    );
    expect(installDirs).toHaveLength(1);
    const installDir = join(packagesDir, installDirs[0]!.name);
    expect(await pathExists(installDir)).toBe(true);
  });

  it('11. Nothing committed', async () => {
    const baseStore = memoryStore();
    const wrappedStore: StateStore = {
      ...baseStore,
      async write(expectedRevision, next) {
        if (next.connectors.length > 0) {
          throw new Error('Injected write failure without storing');
        }
        return baseStore.write(expectedRevision, next);
      },
    };

    const { service, lifecycle, packagesDir } = await setupService({
      store: wrappedStore,
    });

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'NotCommittedPkg',
        arguments: [],
        env: {},
      },
      'owner-a',
    );

    const completed = await waitFor(service, installJob, 'owner-a');
    expect(completed.state).toBe('failed');
    expect(completed.error).toBe('install_failed');

    const entries = await readdir(packagesDir);
    expect(entries.filter((e) => e.endsWith('.installing'))).toHaveLength(0);
    const subdirs = (
      await readdir(packagesDir, { withFileTypes: true })
    ).filter((e) => e.isDirectory() && e.name !== '.jobs');
    expect(subdirs).toHaveLength(0);

    const inv = await lifecycle.inventory();
    expect(inv.connectors).toHaveLength(0);
  });

  it('12. partially_saved', async () => {
    const secrets = memorySecrets();
    secrets.backend.put = async () => {
      throw new Error('Injected credential put failure');
    };

    const { service, lifecycle, packagesDir } = await setupService({
      secretBackend: secrets,
    });

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'PartialPkg',
        arguments: [],
        env: { SECRET_VAL: 'my-secret' },
      },
      'owner-a',
    );

    const completed = await waitFor(service, installJob, 'owner-a');
    expect(completed.state).toBe('succeeded');
    expect(completed.result).toEqual({
      connectorId: expect.any(String),
      outcome: 'partially_saved',
    });

    const inventory = await lifecycle.inventory();
    const stored = inventory.connectors.find(
      (c) => c.id === completed.result!.connectorId,
    );
    expect(stored).toBeDefined();
    expect(stored?.executionMode).toBe('native');
    if (stored?.executionMode !== 'native') {
      throw new Error('Expected native connector');
    }

    const installDir = installDirectory(packagesDir, stored.package!.installId);
    expect(await pathExists(installDir)).toBe(true);
  });

  it('13. Deadline wording', async () => {
    let ciStarted = false;

    const { service, lifecycle } = await setupService({
      runnerOptions: {
        onCi: async (call) => {
          ciStarted = true;
          await new Promise<void>((resolve) => {
            if (call.request.signal.aborted) return resolve();
            call.request.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return {
            outcome: 'cancelled',
            exitCode: null,
            stdout: '',
            stderr: '',
          };
        },
      },
    });

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');
    const preview = resolved.preview!;

    const installJob = await service.install(
      {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'DeadlinePkg',
        arguments: [],
        env: {},
      },
      'owner-a',
    );

    while (!ciStarted) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await lifecycle.close();

    const job = service.job(installJob.id, 'owner-a');
    expect(job.state).toBe('failed');
    expect(job.error).toBe('install_limit');
  });
});
