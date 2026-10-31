import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HubLifecycle } from '@waleed/hub-core';
import type { PackageJob } from '@waleed/contracts';
import { createLifecycle, createMemorySafetyLedger } from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../../packages/hub-core/src/ports.js';
import { memoryStore } from '../helpers/memory-store.js';
import { memorySecrets } from '../helpers/secrets.js';
import {
  createFixtureRegistry,
  sha512Integrity,
  type FixtureRegistry,
} from '../helpers/fixture-registry.js';
import { createTestTls, type TestTls } from '../helpers/tls.js';

interface FakeProcessRunnerCall {
  request: ProcessRequest;
  command: 'lock' | 'ci' | 'other';
  prefixDir: string | null;
  packageJsonContent: string | null;
}

interface FakeProcessRunnerOptions {
  lock?: unknown;
  locks?: Map<string, unknown>;
  defaultBin?: Record<string, string>;
  binMap?: Map<string, Record<string, string>>;
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
  const locks = options.locks
    ? new Map(options.locks)
    : new Map<string, unknown>();
  const binMap = options.binMap
    ? new Map(options.binMap)
    : new Map<string, Record<string, string>>();

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

      if (isCi && prefixDir) {
        const binConfig = binMap.get(pkgName) ??
          options.defaultBin ?? { [pkgName]: 'bin/srv.js' };
        await createDefaultCiFiles(prefixDir, pkgName, pkgVersion, binConfig);
      }

      return {
        outcome: 'exited',
        exitCode: 0,
        stdout: '',
        stderr: '',
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

const host = '127.0.0.1:4177',
  origin = `http://${host}`;

async function login(hub: Awaited<ReturnType<typeof createHubServer>>) {
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host, origin },
    payload: { token: hub.issueLaunchToken() },
  });
  return {
    host,
    origin,
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': response.json<{ csrfToken: string }>().csrfToken,
  };
}

// The poll of a job: the read-only package routes answer 429 after six
// hundred requests a minute, so the poll waits longer and longer until the
// job is over.
async function waitForJobApi(
  hub: Awaited<ReturnType<typeof createHubServer>>,
  jobId: string,
  headers: Record<string, string>,
): Promise<PackageJob> {
  const deadline = Date.now() + 20_000;
  let wait = 25;
  while (Date.now() < deadline) {
    const res = await hub.app.inject({
      method: 'GET',
      url: `/api/packages/jobs/${jobId}`,
      headers,
    });
    if (res.statusCode === 200) {
      const job = res.json<PackageJob>();
      if (job.completedAt) return job;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, 1000);
  }
  throw new Error(`Job ${jobId} timed out waiting for completion`);
}

describe('package-maintenance-api', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  const hubs: Awaited<ReturnType<typeof createHubServer>>[] = [];
  const lifecycles: HubLifecycle[] = [];
  const registries: FixtureRegistry[] = [];
  const secretBackends: ReturnType<typeof memorySecrets>[] = [];
  let sharedTls: TestTls;

  beforeAll(async () => {
    sharedTls = await createTestTls();
  }, 60_000);

  afterAll(async () => {
    if (sharedTls) await sharedTls.dispose();
  });

  afterEach(async () => {
    while (hubs.length > 0) {
      const hub = hubs.pop();
      if (hub) await hub.app.close().catch(() => undefined);
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

  async function setup() {
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

    const lifecycle = createLifecycle(store, Date.now, safety, {
      secrets: { windows: secrets.backend, docker: secrets.backend },
      packages: {
        packagesDir,
        nodeExecutable: process.execPath,
        registry: registry.registry,
        runner: fakeRunner.runner,
      },
    });
    lifecycles.push(lifecycle);

    const hub = await createHubServer({ port: 4177, lifecycle });
    hubs.push(hub);

    return { hub, lifecycle, packagesDir, registry, seeded, fakeRunner };
  }

  it('11. POST /api/packages/cleanup without session answers 401; with session answers 200 with counts, deletes planted orphan without leaking path or UUID', async () => {
    const { hub, packagesDir } = await setup();
    const headers = await login(hub);

    // 1. Without a session -> 401
    const unauthRes = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/cleanup',
      headers: { host, origin },
    });
    expect(unauthRes.statusCode).toBe(401);

    // Let the pass the hub starts on its own finish first, so the orphan
    // below is removed by the requested pass and counted in its answer.
    const settle = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/cleanup',
      headers,
    });
    expect(settle.statusCode).toBe(200);

    // Plant an unreferenced orphan folder
    const orphanId = randomUUID();
    const orphanFolder = join(packagesDir, orphanId);
    await mkdir(orphanFolder, { recursive: true });
    await writeFile(join(orphanFolder, 'orphan.txt'), 'data', 'utf8');
    expect(await pathExists(orphanFolder)).toBe(true);

    // 2. With a session -> 200
    const authRes = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/cleanup',
      headers,
    });
    expect(authRes.statusCode).toBe(200);

    // Body with exactly the keys deleted and retained (numbers)
    const body = authRes.json();
    expect(Object.keys(body).sort()).toEqual(['deleted', 'retained']);
    expect(typeof body.deleted).toBe('number');
    expect(typeof body.retained).toBe('number');
    expect(body.deleted).toBeGreaterThanOrEqual(1);

    // Planted orphan is gone afterwards
    expect(await pathExists(orphanFolder)).toBe(false);

    // Body contains no path and no UUID
    const rawBody = authRes.body;
    expect(rawBody).not.toContain(orphanId);
    expect(rawBody).not.toContain(packagesDir);
    expect(rawBody).not.toContain('/');
    expect(rawBody).not.toContain('\\');
    expect(rawBody).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('12. POST /api/packages/replace returns 202, reaches succeeded, another session gets 404 for that job', async () => {
    const { hub, lifecycle, registry, fakeRunner } = await setup();
    const headersA = await login(hub);

    // Seed srv@1.1.0 as well
    const seeded110 = seedPackage(registry, { version: '1.1.0' });
    fakeRunner.addPackage(seeded110);

    // Resolve srv@1.0.0
    const r1 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers: headersA,
      payload: { name: 'srv', version: '1.0.0' },
    });
    expect(r1.statusCode).toBe(202);
    const resolveJob1 = await waitForJobApi(
      hub,
      r1.json<PackageJob>().id,
      headersA,
    );
    const preview1 = resolveJob1.preview!.previewId;

    // Install srv@1.0.0
    const r2 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/install',
      headers: headersA,
      payload: {
        previewId: preview1,
        entry: 'srv',
        acknowledgedWarnings: resolveJob1.preview!.warnings,
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
    });
    expect(r2.statusCode).toBe(202);
    const installJob = await waitForJobApi(
      hub,
      r2.json<PackageJob>().id,
      headersA,
    );
    expect(installJob.state).toBe('succeeded');

    // Fetch connector from inventory
    const state = await lifecycle.inventory();
    const connector = state.connectors.find(
      (c) => c.id === installJob.result!.connectorId,
    )!;
    expect(connector).toBeDefined();

    // Resolve srv@1.1.0
    const r3 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers: headersA,
      payload: { name: 'srv', version: '1.1.0' },
    });
    expect(r3.statusCode).toBe(202);
    const resolveJob2 = await waitForJobApi(
      hub,
      r3.json<PackageJob>().id,
      headersA,
    );
    const preview2 = resolveJob2.preview!.previewId;

    // POST /api/packages/replace -> 202 with a job of kind: 'replace'
    const repRes = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/replace',
      headers: headersA,
      payload: {
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        previewId: preview2,
        entry: 'srv',
        acknowledgedWarnings: resolveJob2.preview!.warnings,
      },
    });
    expect(repRes.statusCode).toBe(202);
    const repJob = repRes.json<PackageJob>();
    expect(repJob.kind).toBe('replace');

    // Job reaches succeeded
    const completedReplace = await waitForJobApi(hub, repJob.id, headersA);
    expect(completedReplace.state).toBe('succeeded');
    expect(completedReplace.result?.outcome).toBe('saved');

    // Another session gets 404 for that job
    const headersB = await login(hub);
    const otherRes = await hub.app.inject({
      method: 'GET',
      url: `/api/packages/jobs/${repJob.id}`,
      headers: headersB,
    });
    expect(otherRes.statusCode).toBe(404);
  });

  it('13. POST /api/packages/replace with a stale revision returns 409 conflict', async () => {
    const { hub, lifecycle, registry, fakeRunner } = await setup();
    const headers = await login(hub);

    const seeded110 = seedPackage(registry, { version: '1.1.0' });
    fakeRunner.addPackage(seeded110);

    // Resolve and install srv@1.0.0
    const r1 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers,
      payload: { name: 'srv', version: '1.0.0' },
    });
    const resolveJob1 = await waitForJobApi(
      hub,
      r1.json<PackageJob>().id,
      headers,
    );
    const preview1 = resolveJob1.preview!.previewId;

    const r2 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/install',
      headers,
      payload: {
        previewId: preview1,
        entry: 'srv',
        acknowledgedWarnings: resolveJob1.preview!.warnings,
        connectorName: 'Srv Connector',
        arguments: [],
        env: {},
      },
    });
    const installJob = await waitForJobApi(
      hub,
      r2.json<PackageJob>().id,
      headers,
    );
    expect(installJob.state).toBe('succeeded');

    const state = await lifecycle.inventory();
    const connector = state.connectors.find(
      (c) => c.id === installJob.result!.connectorId,
    )!;
    expect(connector).toBeDefined();

    // Resolve srv@1.1.0
    const r3 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers,
      payload: { name: 'srv', version: '1.1.0' },
    });
    const resolveJob2 = await waitForJobApi(
      hub,
      r3.json<PackageJob>().id,
      headers,
    );
    const preview2 = resolveJob2.preview!.previewId;

    // POST /api/packages/replace with a stale revision -> 409 conflict
    const staleRes = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/replace',
      headers,
      payload: {
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision + 99,
        previewId: preview2,
        entry: 'srv',
        acknowledgedWarnings: resolveJob2.preview!.warnings,
      },
    });
    expect(staleRes.statusCode).toBe(409);
    expect(staleRes.json()).toMatchObject({ error: 'conflict' });
  });
});
