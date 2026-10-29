import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  defaultBin?: Record<string, string>;
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

      return {
        outcome: 'exited',
        exitCode: 0,
        stdout: '',
        stderr: '',
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

describe('package-api', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  const hubs: Awaited<ReturnType<typeof createHubServer>>[] = [];
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
    const tempBase = await mkdtemp(join(tmpdir(), 'wmh-svc-'));
    tempDirs.push(tempBase);
    const packagesDir = join(tempBase, 'packages');
    await mkdir(packagesDir, { recursive: true });

    const registry = await createFixtureRegistry({ tls: sharedTls });
    registries.push(registry);

    const seeded = seedPackage(registry);

    const fakeRunner = createFakeRunner({
      lock: seeded.lock,
      defaultBin: seeded.bin,
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

    return { hub, lifecycle, packagesDir, registry, seeded };
  }

  it('14. Without session answers 401; mutation without CSRF answers 403', async () => {
    const { hub } = await setup();
    const loggedIn = await login(hub);

    const dummyUuid = '00000000-0000-4000-8000-000000000000';

    // 14a: Without a session, each of the five routes answers 401
    const noSessionHeaders = { host, origin };

    const r1 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers: noSessionHeaders,
      payload: { name: 'srv', version: '1.0.0' },
    });
    expect(r1.statusCode).toBe(401);

    const r2 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/install',
      headers: noSessionHeaders,
      payload: {
        previewId: dummyUuid,
        entry: 'srv',
        acknowledgedWarnings: [],
        connectorName: 'Srv',
        arguments: [],
        env: {},
      },
    });
    expect(r2.statusCode).toBe(401);

    const r3 = await hub.app.inject({
      method: 'GET',
      url: `/api/packages/jobs/${dummyUuid}`,
      headers: noSessionHeaders,
    });
    expect(r3.statusCode).toBe(401);

    const r4 = await hub.app.inject({
      method: 'POST',
      url: `/api/packages/jobs/${dummyUuid}/cancel`,
      headers: noSessionHeaders,
    });
    expect(r4.statusCode).toBe(401);

    const r5 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/verify/dummy-connector',
      headers: noSessionHeaders,
    });
    expect(r5.statusCode).toBe(401);

    // 14b: A mutation without the CSRF header answers 403
    const noCsrfHeaders = {
      host,
      origin,
      cookie: loggedIn.cookie,
    };

    const m1 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers: noCsrfHeaders,
      payload: { name: 'srv', version: '1.0.0' },
    });
    expect(m1.statusCode).toBe(403);

    const m2 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/install',
      headers: noCsrfHeaders,
      payload: {
        previewId: dummyUuid,
        entry: 'srv',
        acknowledgedWarnings: [],
        connectorName: 'Srv',
        arguments: [],
        env: {},
      },
    });
    expect(m2.statusCode).toBe(403);

    const m3 = await hub.app.inject({
      method: 'POST',
      url: `/api/packages/jobs/${dummyUuid}/cancel`,
      headers: noCsrfHeaders,
    });
    expect(m3.statusCode).toBe(403);

    const m4 = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/verify/dummy-connector',
      headers: noCsrfHeaders,
    });
    expect(m4.statusCode).toBe(403);
  });

  it('15. POST /api/packages/resolve answers 202; GET returns it; reaches succeeded with preview', async () => {
    const { hub } = await setup();
    const headers = await login(hub);

    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers,
      payload: { name: 'srv', version: '1.0.0' },
    });

    expect(response.statusCode).toBe(202);
    const initialJob = response.json<PackageJob>();
    expect(initialJob.kind).toBe('resolve');
    expect(initialJob.id).toBeDefined();

    const getRes = await hub.app.inject({
      method: 'GET',
      url: `/api/packages/jobs/${initialJob.id}`,
      headers,
    });
    expect(getRes.statusCode).toBe(200);

    let currentJob = getRes.json<PackageJob>();
    const deadline = Date.now() + 20_000;
    while (!currentJob.completedAt && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      const poll = await hub.app.inject({
        method: 'GET',
        url: `/api/packages/jobs/${initialJob.id}`,
        headers,
      });
      currentJob = poll.json<PackageJob>();
    }

    expect(currentJob.state).toBe('succeeded');
    expect(currentJob.phase).toBe('complete');
    expect(currentJob.preview).toBeDefined();
    expect(currentJob.preview?.name).toBe('srv');
    expect(currentJob.preview?.version).toBe('1.0.0');
  });

  it('16. POST /api/packages/install answers 202; reaches succeeded; no response body contains env value', async () => {
    const { hub } = await setup();
    const headers = await login(hub);

    const envSentinel = 'sentinel-env-value';
    const recordedBodies: string[] = [];

    // Resolve
    const resResolve = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers,
      payload: { name: 'srv', version: '1.0.0' },
    });
    recordedBodies.push(resResolve.body);
    const resolveJob = resResolve.json<PackageJob>();

    let currentResolve = resolveJob;
    while (!currentResolve.completedAt) {
      await new Promise((r) => setTimeout(r, 10));
      const poll = await hub.app.inject({
        method: 'GET',
        url: `/api/packages/jobs/${resolveJob.id}`,
        headers,
      });
      recordedBodies.push(poll.body);
      currentResolve = poll.json<PackageJob>();
    }
    const preview = currentResolve.preview!;

    // Install
    const resInstall = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/install',
      headers,
      payload: {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'SrvApiInstalled',
        arguments: ['--flag'],
        env: { API_KEY: envSentinel },
      },
    });
    recordedBodies.push(resInstall.body);
    expect(resInstall.statusCode).toBe(202);
    const installJob = resInstall.json<PackageJob>();

    let currentInstall = installJob;
    while (!currentInstall.completedAt) {
      await new Promise((r) => setTimeout(r, 10));
      const poll = await hub.app.inject({
        method: 'GET',
        url: `/api/packages/jobs/${installJob.id}`,
        headers,
      });
      recordedBodies.push(poll.body);
      currentInstall = poll.json<PackageJob>();
    }

    expect(currentInstall.state).toBe('succeeded');
    expect(currentInstall.result?.outcome).toBe('saved');
    expect(currentInstall.result?.connectorId).toBeDefined();

    for (const body of recordedBodies) {
      expect(body).not.toContain(envSentinel);
    }
  });

  it('17. A second session gets 404 for the first session job, both GET and cancel', async () => {
    const { hub } = await setup();
    const session1 = await login(hub);
    const session2 = await login(hub);

    const resResolve = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers: session1,
      payload: { name: 'srv', version: '1.0.0' },
    });
    expect(resResolve.statusCode).toBe(202);
    const job = resResolve.json<PackageJob>();

    const getRes = await hub.app.inject({
      method: 'GET',
      url: `/api/packages/jobs/${job.id}`,
      headers: session2,
    });
    expect(getRes.statusCode).toBe(404);

    const cancelRes = await hub.app.inject({
      method: 'POST',
      url: `/api/packages/jobs/${job.id}/cancel`,
      headers: session2,
    });
    expect(cancelRes.statusCode).toBe(404);
  });

  it('18. POST /api/packages/verify/:connectorId returns verified for installed connector', async () => {
    const { hub } = await setup();
    const headers = await login(hub);

    // Resolve
    const resResolve = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers,
      payload: { name: 'srv', version: '1.0.0' },
    });
    const resolveJob = resResolve.json<PackageJob>();
    let currentResolve = resolveJob;
    while (!currentResolve.completedAt) {
      await new Promise((r) => setTimeout(r, 10));
      const poll = await hub.app.inject({
        method: 'GET',
        url: `/api/packages/jobs/${resolveJob.id}`,
        headers,
      });
      currentResolve = poll.json<PackageJob>();
    }
    const preview = currentResolve.preview!;

    // Install
    const resInstall = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/install',
      headers,
      payload: {
        previewId: preview.previewId,
        entry: preview.entries[0]!.entry,
        acknowledgedWarnings: preview.warnings,
        connectorName: 'SrvVerify',
        arguments: ['--flag'],
        env: {},
      },
    });
    const installJob = resInstall.json<PackageJob>();
    let currentInstall = installJob;
    while (!currentInstall.completedAt) {
      await new Promise((r) => setTimeout(r, 10));
      const poll = await hub.app.inject({
        method: 'GET',
        url: `/api/packages/jobs/${installJob.id}`,
        headers,
      });
      currentInstall = poll.json<PackageJob>();
    }
    expect(currentInstall.state).toBe('succeeded');
    const connectorId = currentInstall.result!.connectorId;

    // Verify
    const verifyRes = await hub.app.inject({
      method: 'POST',
      url: `/api/packages/verify/${connectorId}`,
      headers,
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json()).toEqual({
      connectorId,
      result: 'verified',
    });
  });

  it('19. A lifecycle created without packages adapter answers 503 unavailable on resolve', async () => {
    const store = memoryStore();
    const safety = createMemorySafetyLedger();
    const bareLifecycle = createLifecycle(store, Date.now, safety, {});
    lifecycles.push(bareLifecycle);

    const bareHub = await createHubServer({
      port: 4177,
      lifecycle: bareLifecycle,
    });
    hubs.push(bareHub);

    const headers = await login(bareHub);

    const response = await bareHub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers,
      payload: { name: 'srv', version: '1.0.0' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: 'unavailable',
    });
  });

  it('20. An invalid body ({ name: "Not Valid" }) answers 400 invalid_input', async () => {
    const { hub } = await setup();
    const headers = await login(hub);

    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/packages/resolve',
      headers,
      payload: { name: 'Not Valid' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_input',
    });
  });
});
