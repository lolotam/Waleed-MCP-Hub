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
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  HubLifecycle,
  PackageService,
  StateStore,
} from '@waleed/hub-core';
import type { Connector, PackageJob } from '@waleed/contracts';

type NativeConnector = Extract<Connector, { executionMode: 'native' }>;
import {
  createLifecycle,
  createMemorySafetyLedger,
  definitionHash,
} from '@waleed/hub-core';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../packages/hub-core/src/ports.js';
import {
  installDirectory,
  jobDirectory,
  markerPath,
  removeTree,
  writeMarker,
} from '../packages/hub-core/src/packages/store.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';
import {
  createFixtureRegistry,
  sha512Integrity,
  type FixtureRegistry,
} from './helpers/fixture-registry.js';
import { createTestTls, type TestTls } from './helpers/tls.js';
import { definition } from './helpers/runtime.js';

interface FakeProcessRunnerCall {
  request: ProcessRequest;
  command: 'lock' | 'ci' | 'other';
  prefixDir: string | null;
  packageJsonContent: string | null;
}

interface FakeProcessRunnerOptions {
  lock?: unknown;
  locks?: Map<string, unknown>;
  outcome?: ProcessResult['outcome'];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  defaultBin?: Record<string, string>;
  binMap?: Map<string, Record<string, string>>;
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

function asNative(connector: Connector | undefined): NativeConnector {
  if (!connector || connector.executionMode !== 'native') {
    throw new Error('Expected native connector');
  }
  return connector;
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

async function waitForPath(
  targetPath: string,
  exists: boolean,
  limitMs = 10_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const present = await pathExists(targetPath);
    if (present === exists) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(
    `Timed out waiting for path ${targetPath} to ${exists ? 'exist' : 'be deleted'}`,
  );
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
  const locks = options.locks
    ? new Map(options.locks)
    : new Map<string, unknown>();
  const binMap = options.binMap
    ? new Map(options.binMap)
    : new Map<string, Record<string, string>>();
  let currentOnCi = options.onCi;
  let currentOnLock = options.onLock;

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

      let pkgName = 'srv';
      let pkgVersion = '1.0.0';
      if (packageJsonContent) {
        try {
          const parsed = JSON.parse(packageJsonContent);
          const deps = parsed.dependencies;
          if (deps && typeof deps === 'object') {
            const keys = Object.keys(deps);
            if (keys.length > 0) {
              pkgName = keys[0]!;
              pkgVersion = String(deps[pkgName]);
            }
          }
        } catch {
          // ignore
        }
      }

      if (isLock && prefixDir) {
        const key = `${pkgName}@${pkgVersion}`;
        const lockObj = locks.get(key) ?? options.lock;
        if (lockObj !== undefined) {
          const lockStr =
            typeof lockObj === 'string'
              ? lockObj
              : JSON.stringify(lockObj, null, 2);
          await writeFile(
            join(prefixDir, 'package-lock.json'),
            lockStr,
            'utf8',
          );
        }
      }

      if (isLock && currentOnLock) {
        const res = await currentOnLock(call);
        if (res) return res;
      }
      if (isCi && currentOnCi) {
        const res = await currentOnCi(call);
        if (res) return res;
      }

      if (isCi && prefixDir) {
        const binConfig = binMap.get(pkgName) ??
          options.defaultBin ?? { [pkgName]: 'bin/srv.js' };
        await createDefaultCiFiles(prefixDir, pkgName, pkgVersion, binConfig);
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
  return {
    runner,
    calls,
    addPackage: (seeded: {
      name: string;
      version: string;
      bin: Record<string, string>;
      lock: unknown;
    }) => {
      locks.set(`${seeded.name}@${seeded.version}`, seeded.lock);
      binMap.set(seeded.name, seeded.bin);
    },
    addLock: (key: string, lock: unknown) => locks.set(key, lock),
    setOnCi: (fn?: typeof options.onCi) => {
      currentOnCi = fn;
    },
    setOnLock: (fn?: typeof options.onLock) => {
      currentOnLock = fn;
    },
  };
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
  const bin = options.bin ?? { [name]: 'bin/srv.js' };
  const srvIntegrity = sha512Integrity(`${name}-${version}-bytes`);
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

describe('package-lifecycle', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  const lifecycles: HubLifecycle[] = [];
  const registries: FixtureRegistry[] = [];
  const secretBackends: ReturnType<typeof memorySecrets>[] = [];
  const processesToKill: ChildProcess[] = [];
  let sharedTls: TestTls;

  beforeAll(async () => {
    sharedTls = await createTestTls();
  });

  afterAll(async () => {
    if (sharedTls) await sharedTls.dispose();
  });

  afterEach(async () => {
    while (processesToKill.length > 0) {
      const ps = processesToKill.pop();
      if (ps && !ps.killed) {
        try {
          ps.kill();
        } catch {
          // ignore
        }
      }
    }
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
    const tempBase = await mkdtemp(join(tmpdir(), 'wmh-t7-'));
    tempDirs.push(tempBase);
    const packagesDir = join(tempBase, 'packages');
    await mkdir(packagesDir, { recursive: true });

    const registry = await createFixtureRegistry({ tls: sharedTls });
    registries.push(registry);

    const seeded = seedPackage(registry, options.packageConfig);

    const fakeRunner = createFakeRunner({
      locks: new Map([[`${seeded.name}@${seeded.version}`, seeded.lock]]),
      defaultBin: seeded.bin,
      binMap: new Map([[seeded.name, seeded.bin]]),
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

  it('1. Removal deletes the folder', async () => {
    const { lifecycle, service, packagesDir } = await setupService();

    const resolveJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resolveJob, 'owner-a');

    const installJob = await service.install(
      {
        previewId: resolved.preview!.previewId,
        entry: 'srv',
        acknowledgedWarnings: [],
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completed = await waitFor(service, installJob, 'owner-a');
    expect(completed.state).toBe('succeeded');

    const state = await lifecycle.inventory();
    const connector = asNative(
      state.connectors.find((c) => c.name === 'Srv Connector'),
    );
    expect(connector).toBeDefined();
    const installId = connector.package!.installId;
    const folder = installDirectory(packagesDir, installId);
    expect(await pathExists(folder)).toBe(true);

    const preview = await lifecycle.preview(
      {
        kind: 'remove_connector',
        connectorId: connector.id,
        expectedRevision: state.revision,
      },
      'owner-a',
    );
    const applyJob = await lifecycle.apply(preview.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(applyJob.id, 'owner-a').state).toBe('succeeded');

    await waitForPath(folder, false);
    expect(await pathExists(folder)).toBe(false);
  });

  it('2. Ordinary removal triggers nothing', async () => {
    const { lifecycle, service, packagesDir } = await setupService();

    // Await service.reconcile() once first so startup pass has finished
    await service.reconcile();

    // Create an ordinary native connector
    const ordinaryDef = definition({
      id: 'ordinary-native',
      name: 'Ordinary Native',
      command: 'node',
      args: ['fixture.js'],
    });
    const prev = await lifecycle.preview(
      {
        kind: 'create_connector',
        expectedRevision: (await lifecycle.inventory()).revision,
        definition: ordinaryDef,
      },
      'owner-a',
    );
    const createJob = await lifecycle.apply(prev.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(createJob.id, 'owner-a').state).toBe('succeeded');

    // Plant an unreferenced UUID folder under packagesDir AFTER startup pass
    const plantedUuid = randomUUID();
    const plantedFolder = join(packagesDir, plantedUuid);
    await mkdir(plantedFolder, { recursive: true });
    await writeFile(join(plantedFolder, 'file.txt'), 'planted', 'utf8');

    // Remove the ordinary connector
    const removePrev = await lifecycle.preview(
      {
        kind: 'remove_connector',
        connectorId: 'ordinary-native',
        expectedRevision: (await lifecycle.inventory()).revision,
      },
      'owner-a',
    );
    const removeJob = await lifecycle.apply(removePrev.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(removeJob.id, 'owner-a').state).toBe('succeeded');

    // The planted folder still exists 500 ms later (fixed wait permitted for this case)
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await pathExists(plantedFolder)).toBe(true);
  });

  it('3. Startup reconciliation', async () => {
    const tempBase = await mkdtemp(join(tmpdir(), 'wmh-t7-'));
    tempDirs.push(tempBase);
    const packagesDir = join(tempBase, 'packages');
    await mkdir(packagesDir, { recursive: true });

    const registry = await createFixtureRegistry({ tls: sharedTls });
    registries.push(registry);
    const seeded = seedPackage(registry);
    const fakeRunner = createFakeRunner({
      locks: new Map([[`${seeded.name}@${seeded.version}`, seeded.lock]]),
      defaultBin: seeded.bin,
      binMap: new Map([[seeded.name, seeded.bin]]),
    });

    const store = memoryStore();
    const safety = createMemorySafetyLedger();
    const secrets = memorySecrets();
    secretBackends.push(secrets);

    // Install once to populate the state store with a valid managed connector
    const lc1 = createLifecycle(store, Date.now, safety, {
      secrets: { windows: secrets.backend, docker: secrets.backend },
      packages: {
        packagesDir,
        nodeExecutable: process.execPath,
        registry: registry.registry,
        runner: fakeRunner.runner,
      },
    });
    lifecycles.push(lc1);

    const resJob = lc1.packages!.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(lc1.packages!, resJob, 'owner-a');
    const instJob = await lc1.packages!.install(
      {
        previewId: resolved.preview!.previewId,
        entry: 'srv',
        acknowledgedWarnings: [],
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    await waitFor(lc1.packages!, instJob, 'owner-a');

    const referencedConnector = asNative(
      (await lc1.inventory()).connectors.find(
        (c) => c.name === 'Srv Connector',
      ),
    );
    const referencedInstallId = referencedConnector.package!.installId;
    const referencedFolder = installDirectory(packagesDir, referencedInstallId);

    // Close the initial lifecycle
    await lc1.close();

    // Before creating the lifecycle, plant:
    // 1. an unreferenced install folder <packagesDir>\<uuid> with a file in it
    const orphanId1 = randomUUID();
    const orphanFolder1 = join(packagesDir, orphanId1);
    await mkdir(orphanFolder1, { recursive: true });
    await writeFile(join(orphanFolder1, 'orphan1.txt'), 'data1', 'utf8');

    // 2. a marker <packagesDir>\<uuid2>.installing holding a random job id with its folder
    const orphanId2 = randomUUID();
    const orphanFolder2 = join(packagesDir, orphanId2);
    await mkdir(orphanFolder2, { recursive: true });
    await writeFile(join(orphanFolder2, 'orphan2.txt'), 'data2', 'utf8');
    await writeMarker(packagesDir, orphanId2, randomUUID());
    const marker2 = markerPath(packagesDir, orphanId2);

    // 3. a leftover <packagesDir>\.jobs\<uuid3> folder
    const orphanJobId3 = randomUUID();
    const orphanJobFolder3 = jobDirectory(packagesDir, orphanJobId3);
    await mkdir(orphanJobFolder3, { recursive: true });
    await writeFile(join(orphanJobFolder3, 'job3.txt'), 'data3', 'utf8');

    // Verify all 4 folders and the marker exist before startup
    expect(await pathExists(orphanFolder1)).toBe(true);
    expect(await pathExists(orphanFolder2)).toBe(true);
    expect(await pathExists(marker2)).toBe(true);
    expect(await pathExists(orphanJobFolder3)).toBe(true);
    expect(await pathExists(referencedFolder)).toBe(true);

    // Reopen lifecycle on the same memoryStore
    const lc2 = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      secrets: { windows: secrets.backend, docker: secrets.backend },
      packages: {
        packagesDir,
        nodeExecutable: process.execPath,
        registry: registry.registry,
        runner: fakeRunner.runner,
      },
    });
    lifecycles.push(lc2);

    // Poll until the three orphans are gone; the referenced folder stays
    await waitForPath(orphanFolder1, false);
    await waitForPath(orphanFolder2, false);
    await waitForPath(marker2, false);
    await waitForPath(orphanJobFolder3, false);

    expect(await pathExists(referencedFolder)).toBe(true);
  });

  it('4. Live folders survive', async () => {
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let holdRunner = false;

    const { service, packagesDir } = await setupService({
      runnerOptions: {
        onLock: async () => {
          if (holdRunner) {
            await runnerGate;
          }
        },
      },
    });

    // 1. Stored preview (resolve finished, not installed)
    const resJob1 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    await waitFor(service, resJob1, 'owner-a');
    const storedJobFolder = jobDirectory(packagesDir, resJob1.id);
    expect(await pathExists(storedJobFolder)).toBe(true);

    // 2. Running lookup held open by the fake runner
    holdRunner = true;
    const resJob2 = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const runningJobFolder = jobDirectory(packagesDir, resJob2.id);
    await waitForPath(runningJobFolder, true);

    // Call service.reconcile(): both job folders under .jobs survive
    await service.reconcile();

    expect(await pathExists(storedJobFolder)).toBe(true);
    expect(await pathExists(runningJobFolder)).toBe(true);

    // Release the runner afterwards
    releaseRunner();
    await waitFor(service, resJob2, 'owner-a');
  });

  it.skipIf(process.platform !== 'win32')('5. Folder in use', async () => {
    const { service, packagesDir } = await setupService();
    await service.reconcile();

    const unrefId = randomUUID();
    const unrefFolder = join(packagesDir, unrefId);
    await mkdir(unrefFolder, { recursive: true });
    const unrefFile = join(unrefFolder, 'in-use.txt');
    await writeFile(unrefFile, 'held content', 'utf8');

    // Open file in child process without FileShare.Delete so unlink fails on Windows
    const script = `
$stream = [System.IO.File]::Open('${unrefFile.replace(/'/g, "''")}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
[Console]::WriteLine('LOCKED')
[System.Threading.Thread]::Sleep(30000)
`;
    const ps = spawn('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    processesToKill.push(ps);

    await new Promise<void>((resolve, reject) => {
      ps.stdout.on('data', (d) => {
        if (d.toString().includes('LOCKED')) resolve();
      });
      ps.on('error', reject);
    });

    // Verify on this machine that removeTree really returns false for it
    const removed = await removeTree(unrefFolder, packagesDir);
    expect(removed).toBe(false);

    // reconcile() resolves with retained >= 1
    const r1 = await service.reconcile();
    expect(r1.retained).toBeGreaterThanOrEqual(1);
    expect(await pathExists(unrefFolder)).toBe(true);

    // Close the handle
    ps.kill();
    await new Promise<void>((resolve) => ps.on('exit', () => resolve()));

    // The next reconcile() deletes it
    const r2 = await service.reconcile();
    expect(r2.deleted).toBeGreaterThanOrEqual(1);
    await waitForPath(unrefFolder, false);
  });

  it('6. Follow-up pass', async () => {
    const store = memoryStore();
    let holdNextReconcileRead = false;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });

    const interceptedStore: StateStore = {
      async read() {
        const state = await store.read();
        if (holdNextReconcileRead) {
          holdNextReconcileRead = false;
          readStarted();
          await readGate;
        }
        return state;
      },
      write: (expected, next) => store.write(expected, next),
      close: () => store.close(),
    };

    const { lifecycle, service, packagesDir } = await setupService({
      store: interceptedStore,
    });

    // Let startup pass complete
    await service.reconcile();

    // Install a managed connector
    const resJob = service.resolve(
      { name: 'srv', version: '1.0.0' },
      'owner-a',
    );
    const resolved = await waitFor(service, resJob, 'owner-a');
    const instJob = await service.install(
      {
        previewId: resolved.preview!.previewId,
        entry: 'srv',
        acknowledgedWarnings: [],
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    await waitFor(service, instJob, 'owner-a');

    const connector = asNative(
      (await lifecycle.inventory()).connectors.find(
        (c) => c.name === 'Srv Connector',
      ),
    );
    const folder = installDirectory(packagesDir, connector.package!.installId);
    expect(await pathExists(folder)).toBe(true);

    // Hold the first reconcile read
    holdNextReconcileRead = true;
    const p1 = service.reconcile();
    await readStartedPromise;

    // Two calls made while the first pass was held return the same promise
    const p2 = service.reconcile();
    const p3 = service.reconcile();
    expect(p2).toBe(p3);

    // Remove the managed connector
    const prev = await lifecycle.preview(
      {
        kind: 'remove_connector',
        connectorId: connector.id,
        expectedRevision: (await lifecycle.inventory()).revision,
      },
      'owner-a',
    );
    const remJob = await lifecycle.apply(prev.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(remJob.id, 'owner-a').state).toBe('succeeded');

    // Folder still exists while p1 was held
    expect(await pathExists(folder)).toBe(true);

    // Release the read
    releaseRead();
    await p1;
    await p2;

    // Its folder is deleted (the follow-up pass ran after the removal)
    await waitForPath(folder, false);
  });

  it('7. Replace keeps the connector', async () => {
    const { lifecycle, service, packagesDir, registry, fakeRunner } =
      await setupService({
        packageConfig: { name: 'srv', version: '1.0.0' },
      });

    // Seed srv@1.1.0 as well
    const seeded110 = seedPackage(registry, { name: 'srv', version: '1.1.0' });
    fakeRunner.addPackage(seeded110);

    // Install srv@1.0.0 with arguments ['--flag'], env { API_TOKEN: 'token-val' }
    const res1 = service.resolve({ name: 'srv', version: '1.0.0' }, 'owner-a');
    const resolved1 = await waitFor(service, res1, 'owner-a');
    const instJob = await service.install(
      {
        previewId: resolved1.preview!.previewId,
        entry: 'srv',
        acknowledgedWarnings: resolved1.preview!.warnings,
        connectorName: 'Srv Connector',
        arguments: ['--flag'],
        env: { API_TOKEN: 'token-val' },
      },
      'owner-a',
    );
    const completedInst = await waitFor(service, instJob, 'owner-a');
    expect(completedInst.state).toBe('succeeded');

    let state = await lifecycle.inventory();
    let connector = asNative(
      state.connectors.find((c) => c.name === 'Srv Connector'),
    );
    const oldInstallId = connector.package!.installId;
    const oldFolder = installDirectory(packagesDir, oldInstallId);
    expect(await pathExists(oldFolder)).toBe(true);

    // Add connector to a profile
    const profPrev = await lifecycle.preview(
      {
        kind: 'create_profile',
        expectedRevision: state.revision,
        name: 'Main Profile',
        description: '',
        connectorIds: [connector.id],
      },
      'owner-a',
    );
    const profJob = await lifecycle.apply(profPrev.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(profJob.id, 'owner-a').state).toBe('succeeded');

    // Approve it (approve_connector)
    state = await lifecycle.inventory();
    connector = asNative(state.connectors.find((c) => c.id === connector.id));
    expect(connector.trustApproval).toBeNull();
    const appPrev = await lifecycle.preview(
      {
        kind: 'approve_connector',
        expectedRevision: state.revision,
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        definitionHash: definitionHash(connector),
        approveExecution: true,
      },
      'owner-a',
    );
    const appJob = await lifecycle.apply(appPrev.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(appJob.id, 'owner-a').state).toBe('succeeded');

    state = await lifecycle.inventory();
    connector = asNative(state.connectors.find((c) => c.id === connector.id));
    expect(connector.trustApproval).not.toBeNull();
    const priorRevision = connector.revision;

    // Resolve srv@1.1.0
    const res2 = service.resolve({ name: 'srv', version: '1.1.0' }, 'owner-a');
    const resolved2 = await waitFor(service, res2, 'owner-a');
    const preview2 = resolved2.preview!;

    // Replace
    const replaceJob = await service.replace(
      {
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        previewId: preview2.previewId,
        entry: 'srv',
        acknowledgedWarnings: preview2.warnings,
      },
      'owner-a',
    );

    // The job (kind: 'replace') succeeds with outcome: 'saved'
    expect(replaceJob.kind).toBe('replace');
    const completedReplace = await waitFor(service, replaceJob, 'owner-a');
    expect(completedReplace.state).toBe('succeeded');
    expect(completedReplace.result?.outcome).toBe('saved');

    // The stored connector has the new package.version and a new installId
    state = await lifecycle.inventory();
    const updated = asNative(
      state.connectors.find((c) => c.id === connector.id),
    );
    expect(updated.package?.version).toBe('1.1.0');
    expect(updated.package?.installId).not.toBe(oldInstallId);
    const newInstallId = updated.package!.installId;
    const newFolder = installDirectory(packagesDir, newInstallId);

    // arguments[1] points into the new install, arguments[2] === '--flag'
    expect(updated.arguments[0]).toBe('--no-global-search-paths');
    expect(updated.arguments[1]).toContain(newInstallId);
    expect(updated.arguments[2]).toBe('--flag');

    // API_TOKEN binding is unchanged
    expect(updated.secretBindings.API_TOKEN).toBe(
      connector.secretBindings.API_TOKEN,
    );

    // Profile still contains it
    const profile = state.profiles.find((p) => p.name === 'Main Profile')!;
    expect(profile.connectorIds).toContain(updated.id);

    // trustApproval is null, and its revision went up
    expect(updated.trustApproval).toBeNull();
    expect(updated.revision).toBeGreaterThan(priorRevision);

    // The old install folder is deleted (poll); the new one exists
    await waitForPath(oldFolder, false);
    expect(await pathExists(newFolder)).toBe(true);
  });

  it('8. Replace refusals', async () => {
    const { lifecycle, service, registry, fakeRunner } = await setupService({
      packageConfig: { name: 'srv', version: '1.0.0' },
    });

    const seeded110 = seedPackage(registry, { name: 'srv', version: '1.1.0' });
    fakeRunner.addPackage(seeded110);

    const seededOther = seedPackage(registry, {
      name: 'other-pkg',
      version: '1.0.0',
    });
    fakeRunner.addPackage(seededOther);

    // Install srv@1.0.0
    const res1 = service.resolve({ name: 'srv', version: '1.0.0' }, 'owner-a');
    const resolved1 = await waitFor(service, res1, 'owner-a');
    const inst1 = await service.install(
      {
        previewId: resolved1.preview!.previewId,
        entry: 'srv',
        acknowledgedWarnings: resolved1.preview!.warnings,
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completedInst1 = await waitFor(service, inst1, 'owner-a');
    expect(completedInst1.state).toBe('succeeded');

    // Create an ordinary native connector
    const ordDef = definition({
      id: 'ord-conn',
      name: 'Ordinary',
      command: 'node',
      args: ['app.js'],
    });
    const ordPrev = await lifecycle.preview(
      {
        kind: 'create_connector',
        expectedRevision: (await lifecycle.inventory()).revision,
        definition: ordDef,
      },
      'owner-a',
    );
    const ordJob = await lifecycle.apply(ordPrev.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(ordJob.id, 'owner-a').state).toBe('succeeded');

    // Resolve srv@1.1.0
    const res2 = service.resolve({ name: 'srv', version: '1.1.0' }, 'owner-a');
    const resolved2 = await waitFor(service, res2, 'owner-a');
    const previewSrv110 = resolved2.preview!.previewId;

    // Resolve other-pkg@1.0.0
    const resOther = service.resolve(
      { name: 'other-pkg', version: '1.0.0' },
      'owner-a',
    );
    const resolvedOther = await waitFor(service, resOther, 'owner-a');
    const previewOther = resolvedOther.preview!.previewId;

    const state = await lifecycle.inventory();
    const srvConn = state.connectors.find((c) => c.name === 'Srv Connector')!;

    const jobsBefore = service.activeJobs().size;

    // 1. unknown connector -> not_found
    await expect(
      service.replace(
        {
          connectorId: randomUUID(),
          expectedConnectorRevision: 1,
          previewId: previewSrv110,
          entry: 'srv',
          acknowledgedWarnings: [],
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    // 2. ordinary connector -> invalid
    await expect(
      service.replace(
        {
          connectorId: 'ord-conn',
          expectedConnectorRevision: 1,
          previewId: previewSrv110,
          entry: 'srv',
          acknowledgedWarnings: [],
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'invalid' });

    // 3. stale expectedConnectorRevision -> conflict
    await expect(
      service.replace(
        {
          connectorId: srvConn.id,
          expectedConnectorRevision: srvConn.revision + 42,
          previewId: previewSrv110,
          entry: 'srv',
          acknowledgedWarnings: [],
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    // 4. a preview of another package name -> invalid
    await expect(
      service.replace(
        {
          connectorId: srvConn.id,
          expectedConnectorRevision: srvConn.revision,
          previewId: previewOther,
          entry: 'other-pkg',
          acknowledgedWarnings: [],
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'invalid' });

    // No jobs created for refusals
    expect(service.activeJobs().size).toBe(jobsBefore);

    // 5. a second replace or an install while one runs -> busy
    let releaseCi!: () => void;
    const ciGate = new Promise<void>((resolve) => {
      releaseCi = resolve;
    });
    fakeRunner.setOnCi(async () => {
      await ciGate;
    });

    const runningReplace = await service.replace(
      {
        connectorId: srvConn.id,
        expectedConnectorRevision: srvConn.revision,
        previewId: previewSrv110,
        entry: 'srv',
        acknowledgedWarnings: resolved2.preview!.warnings,
      },
      'owner-a',
    );

    // While running, a second replace is busy
    await expect(
      service.replace(
        {
          connectorId: srvConn.id,
          expectedConnectorRevision: srvConn.revision,
          previewId: previewSrv110,
          entry: 'srv',
          acknowledgedWarnings: [],
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'busy' });

    // And an install while one runs is busy
    await expect(
      service.install(
        {
          previewId: previewOther,
          entry: 'other-pkg',
          acknowledgedWarnings: [],
          connectorName: 'Other Connector',
          arguments: [],
          env: {},
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({ code: 'busy' });

    // Release runner and wait for completion
    fakeRunner.setOnCi(undefined);
    releaseCi();
    const completed = await waitFor(service, runningReplace, 'owner-a');
    expect(completed.state).toBe('succeeded');
  });

  it('9. Replace revision conflict at save time', async () => {
    const { lifecycle, service, packagesDir, registry, fakeRunner } =
      await setupService({
        packageConfig: { name: 'srv', version: '1.0.0' },
      });

    const seeded110 = seedPackage(registry, { name: 'srv', version: '1.1.0' });
    fakeRunner.addPackage(seeded110);

    // Install srv@1.0.0
    const res1 = service.resolve({ name: 'srv', version: '1.0.0' }, 'owner-a');
    const resolved1 = await waitFor(service, res1, 'owner-a');
    const inst1 = await service.install(
      {
        previewId: resolved1.preview!.previewId,
        entry: 'srv',
        acknowledgedWarnings: resolved1.preview!.warnings,
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completedInst1 = await waitFor(service, inst1, 'owner-a');
    expect(completedInst1.state).toBe('succeeded');

    let state = await lifecycle.inventory();
    let connector = asNative(
      state.connectors.find((c) => c.name === 'Srv Connector'),
    );
    const oldInstallId = connector.package!.installId;
    const oldFolder = installDirectory(packagesDir, oldInstallId);
    expect(await pathExists(oldFolder)).toBe(true);

    // Resolve srv@1.1.0
    const res2 = service.resolve({ name: 'srv', version: '1.1.0' }, 'owner-a');
    const resolved2 = await waitFor(service, res2, 'owner-a');
    const preview110 = resolved2.preview!.previewId;

    // Hold the ci run in the fake runner
    let releaseCi!: () => void;
    const ciGate = new Promise<void>((resolve) => {
      releaseCi = resolve;
    });
    let ciStarted!: () => void;
    const ciStartedPromise = new Promise<void>((resolve) => {
      ciStarted = resolve;
    });

    fakeRunner.setOnCi(async () => {
      ciStarted();
      await ciGate;
    });

    const replaceJob = await service.replace(
      {
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        previewId: preview110,
        entry: 'srv',
        acknowledgedWarnings: resolved2.preview!.warnings,
      },
      'owner-a',
    );

    // Wait for ci to start
    await ciStartedPromise;

    // Find the new install folder / marker being prepared
    const entries = await readdir(packagesDir);
    const newMarkerName = entries.find(
      (e) => e.endsWith('.installing') && !e.startsWith(oldInstallId),
    );
    expect(newMarkerName).toBeDefined();
    const newInstallId = newMarkerName!.replace('.installing', '');
    const newFolder = installDirectory(packagesDir, newInstallId);
    const newMarker = markerPath(packagesDir, newInstallId);

    // Meanwhile, edit the connector name with edit_connector
    state = await lifecycle.inventory();
    connector = asNative(state.connectors.find((c) => c.id === connector.id));
    const editPrev = await lifecycle.preview(
      {
        kind: 'edit_connector',
        connectorId: connector.id,
        expectedRevision: state.revision,
        definition: {
          id: connector.id,
          name: 'Renamed Srv Connector',
          description: connector.description,
          executionMode: connector.executionMode,
          transport: connector.transport,
          executable: connector.executable,
          arguments: connector.arguments,
          environmentLiterals: connector.environmentLiterals,
          secretBindings: connector.secretBindings,
          headerBindings: connector.headerBindings,
          enabled: connector.enabled,
          trustApproval: null,
        },
      },
      'owner-a',
    );
    const editJob = await lifecycle.apply(editPrev.id, 'owner-a');
    await lifecycle.drain();
    expect(lifecycle.job(editJob.id, 'owner-a').state).toBe('succeeded');

    // Release ci
    fakeRunner.setOnCi(undefined);
    releaseCi();

    // The job ends failed with install_failed
    const finishedReplace = await waitFor(service, replaceJob, 'owner-a');
    expect(finishedReplace.state).toBe('failed');
    expect(finishedReplace.error).toBe('install_failed');

    // The new install folder and its marker are gone
    await waitForPath(newFolder, false);
    await waitForPath(newMarker, false);

    // The old folder and the old package record are unchanged
    expect(await pathExists(oldFolder)).toBe(true);
    state = await lifecycle.inventory();
    const preserved = asNative(
      state.connectors.find((c) => c.id === connector.id),
    );
    expect(preserved.package?.installId).toBe(oldInstallId);
    expect(preserved.package?.version).toBe('1.0.0');
  });

  it('10. Expired preview in replace', async () => {
    const { lifecycle, service, registry, fakeRunner } = await setupService({
      packageConfig: { name: 'srv', version: '1.0.0' },
    });

    const seeded110 = seedPackage(registry, { name: 'srv', version: '1.1.0' });
    fakeRunner.addPackage(seeded110);

    // Install srv@1.0.0
    const res1 = service.resolve({ name: 'srv', version: '1.0.0' }, 'owner-a');
    const resolved1 = await waitFor(service, res1, 'owner-a');
    const inst1 = await service.install(
      {
        previewId: resolved1.preview!.previewId,
        entry: 'srv',
        acknowledgedWarnings: resolved1.preview!.warnings,
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
      'owner-a',
    );
    const completedInst1 = await waitFor(service, inst1, 'owner-a');
    expect(completedInst1.state).toBe('succeeded');

    // Resolve srv@1.1.0
    const res2 = service.resolve({ name: 'srv', version: '1.1.0' }, 'owner-a');
    const resolved2 = await waitFor(service, res2, 'owner-a');
    const preview110 = resolved2.preview!.previewId;

    let state = await lifecycle.inventory();
    let connector = asNative(
      state.connectors.find((c) => c.name === 'Srv Connector'),
    );

    // First replace consumes preview110
    const replaceJob1 = await service.replace(
      {
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        previewId: preview110,
        entry: 'srv',
        acknowledgedWarnings: resolved2.preview!.warnings,
      },
      'owner-a',
    );
    const completed1 = await waitFor(service, replaceJob1, 'owner-a');
    expect(completed1.state).toBe('succeeded');

    // Connector revision is now incremented
    state = await lifecycle.inventory();
    connector = asNative(state.connectors.find((c) => c.id === connector.id));

    // A previewId that was already used -> the job ends failed with preview_expired
    const replaceJob2 = await service.replace(
      {
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        previewId: preview110,
        entry: 'srv',
        acknowledgedWarnings: [],
      },
      'owner-a',
    );

    const completed2 = await waitFor(service, replaceJob2, 'owner-a');
    expect(completed2.state).toBe('failed');
    expect(completed2.error).toBe('preview_expired');
  });
});
