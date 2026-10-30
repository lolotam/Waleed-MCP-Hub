import { afterEach, expect, it, vi } from 'vitest';
import {
  createLifecycle,
  createPlatformCredentialStorage,
  emptyState,
  platformAgentTargets,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from '../helpers/memory-store.js';
import { agentSource } from '../helpers/more-agents.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('protects storage diagnostics and native probes with browser session/Origin/CSRF, returning only structural status on failure', async () => {
  const has = vi.fn(async () => {
      throw new Error('SYNTHETIC-PRIVATE-KEYRING-FAILURE');
    }),
    storage = createPlatformCredentialStorage({
      directory: 'unused',
      platform: 'linux',
      open: {
        libsecret: async () => ({
          has,
          async put() {
            throw new Error();
          },
          async delete() {
            throw new Error();
          },
        }),
      },
    });
  const hub = createLifecycle(memoryStore(), Date.now, undefined, {
      credentialStorage: storage,
      secrets: storage.backends,
    }),
    server = await createHubServer({ port: 4177, lifecycle: hub });
  cleanup.push(() => server.app.close());
  const base = { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' };
  expect(
    (
      await server.app.inject({
        method: 'GET',
        url: '/api/credential-storage',
        headers: base,
      })
    ).statusCode,
  ).toBe(401);
  const session = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: base,
      payload: { token: server.issueLaunchToken() },
    }),
    headers = {
      ...base,
      cookie: session.headers['set-cookie']!.toString().split(';')[0]!,
      'x-csrf-token': session.json().csrfToken,
    };
  expect(
    (
      await server.app.inject({
        method: 'GET',
        url: '/api/credential-storage',
        headers,
      })
    ).json(),
  ).toMatchObject({ backend: 'libsecret', state: 'not_checked' });
  expect(has).not.toHaveBeenCalled();
  for (const extra of [
    { origin: 'https://foreign.test' },
    { 'x-csrf-token': 'bad' },
  ])
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/credential-storage/check',
          headers: { ...headers, ...extra },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  expect(has).not.toHaveBeenCalled();
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/credential-storage/check',
    headers,
    payload: {},
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    backend: 'libsecret',
    state: 'unavailable',
    containment: 'posix-process-group',
  });
  expect(result.body).not.toContain('SYNTHETIC-PRIVATE');
  expect(has).toHaveBeenCalledTimes(1);
});
it.each(['linux', 'darwin'] as const)(
  '%s agent integration uses POSIX scope handles and package-manifest paths for all 17 identities',
  async (platform) => {
    const targets = platformAgentTargets(platform, '/home/synthetic', {}),
      contents = new Map(
        targets.map((target) => [target.paths[0]!, agentSource(target)]),
      ),
      originals = new Map(contents),
      reads: string[] = [],
      backups: string[] = [];
    const hub = createLifecycle(
      memoryStore(emptyState()),
      Date.now,
      undefined,
      {
        integrations: {
          platform,
          targets,
          node: '/usr/bin/node',
          registry: '/data/hub/state.json',
          bridge: '/app/hub/bridge.js',
          files: {
            async read(path) {
              return contents.get(path) ?? null;
            },
            async replace(path, before, after) {
              if (contents.get(path) !== before)
                throw new Error('Synthetic drift');
              contents.set(path, after);
            },
            async backup(id, text) {
              expect(text).toBe(
                originals.get(
                  targets.find((target) => target.id === id)!.paths[0]!,
                ),
              );
              backups.push(id);
              return `${id}-private.bak`;
            },
          },
          discovery: {
            async find() {
              return ['/usr/bin/agent'];
            },
            async read(path) {
              reads.push(path);
              return { status: 'missing' };
            },
            async run() {
              throw new Error('Scan must not execute');
            },
          },
        },
      },
    );
    cleanup.push(() => hub.close());
    const scan = await hub.integrations.scan();
    expect(scan.agents).toHaveLength(17);
    for (const agent of scan.agents) {
      expect(agent.status).toBe('not_integrated');
      await hub.integrations.integrate(agent.agentId, {
        expectedRevision: (await hub.inventory()).revision,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      });
    }
    expect((await hub.inventory()).integrations).toHaveLength(17);
    expect(backups).toHaveLength(17);
    expect(
      reads.every(
        (path) =>
          path.startsWith('/usr/bin/node_modules/') && !path.includes('\\'),
      ),
    ).toBe(true);
    expect(
      (await hub.integrations.sync()).agents.every(
        (agent) => agent.status === 'synced',
      ),
    ).toBe(true);
  },
);
