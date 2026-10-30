import { afterEach, expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsAgentTargets,
  createRegistryClient,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from '../helpers/memory-store.js';
import { memorySecrets } from '../helpers/secrets.js';
import { profileState } from '../helpers/runtime.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const secrets = memorySecrets(),
    state = profileState([]),
    target = windowsAgentTargets('C:\\Synthetic', {}).find(
      (target) => target.id === 'cursor',
    )!;
  let source = JSON.stringify({
    mcpServers: {
      Private: {
        command: 'npx',
        args: ['synthetic@1.2.3'],
        env: { TOKEN: 'SYNTHETIC-HTTP-IMPORT-SECRET' },
      },
    },
    other: 'keep',
  });
  const lifecycle = createLifecycle(
    memoryStore(state),
    Date.now,
    createMemorySafetyLedger(),
    {
      secrets: { windows: secrets.backend },
      integrations: {
        targets: [target],
        files: {
          read: async (path) => (path === target.paths[0] ? source : null),
          replace: async (_path, before, after) => {
            if (source !== before) throw new Error();
            source = after;
          },
          backup: async () => {
            throw new Error('No plaintext backup');
          },
        },
        node: 'C:\\Node\\node.exe',
        registry: 'C:\\Runtime\\state.json',
        discovery: {
          find: async () => [],
          read: async () => ({ status: 'missing' }),
          run: async () => {
            throw new Error();
          },
        },
      },
    },
  );
  const registry = createRegistryClient();
  let registryCalls = 0;
  registry.search = async () => {
    registryCalls++;
    return {
      source: 'https://registry.modelcontextprotocol.io',
      servers: [],
      nextCursor: null,
    };
  };
  const server = await createHubServer({ port: 4177, lifecycle, registry });
  cleanup.push(async () => {
    await server.app.close();
    secrets.close();
  });
  const headers = { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' };
  const session = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers,
    payload: { token: server.issueLaunchToken() },
  });
  return {
    server,
    lifecycle,
    secrets,
    getSource: () => source,
    getRegistryCalls: () => registryCalls,
    headers: {
      ...headers,
      cookie: String(session.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
    },
  };
}
it('requires session/Origin/CSRF for adoption and apply, and never leaks source credentials through HTTP DTOs', async () => {
  const f = await setup();
  for (const url of [
    '/api/adoption/agents/cursor/preview',
    '/api/imports/not-a-draft/apply',
  ]) {
    expect(
      (
        await f.server.app.inject({
          method: 'POST',
          url,
          headers: { host: f.headers.host, origin: f.headers.origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.server.app.inject({
          method: 'POST',
          url,
          headers: {
            host: f.headers.host,
            origin: f.headers.origin,
            cookie: f.headers.cookie,
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  }
  const preview = await f.server.app.inject({
    method: 'POST',
    url: '/api/adoption/agents/cursor/preview',
    headers: f.headers,
    payload: { expectedRevision: 0 },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.body).not.toContain('SYNTHETIC-HTTP-IMPORT-SECRET');
  const id = preview.json<{ id: string }>().id;
  const result = await f.server.app.inject({
    method: 'POST',
    url: `/api/imports/${id}/apply`,
    headers: f.headers,
    payload: {
      expectedRevision: 0,
      profileIds: ['profile'],
      confirmImport: true,
      confirmAgentConfigChange: true,
    },
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    state: 'imported',
    requiresApproval: true,
  });
  expect(f.getSource()).not.toContain('SYNTHETIC-HTTP-IMPORT-SECRET');
  for (const url of [
    '/api/connectors',
    '/api/credentials',
    '/api/profiles',
    '/api/recovery',
    '/api/activity',
  ]) {
    const response = await f.server.app.inject({ url, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('SYNTHETIC-HTTP-IMPORT-SECRET');
  }
});
it('guards official registry searches behind the Hub session without calling the registry on unauthenticated requests', async () => {
  const f = await setup();
  expect(
    (
      await f.server.app.inject({
        url: '/api/registry/servers?search=tools',
        headers: { host: f.headers.host },
      })
    ).statusCode,
  ).toBe(401);
  expect(f.getRegistryCalls()).toBe(0);
  const result = await f.server.app.inject({
    url: '/api/registry/servers?search=tools',
    headers: f.headers,
  });
  expect(result.statusCode).toBe(200);
  expect(f.getRegistryCalls()).toBe(1);
  expect(f.secrets.values.size).toBe(0);
});
it('requires local HTTP consent at the manual HTTP API boundary while keeping headers protected', async () => {
  const f = await setup(),
    privateValue = 'SYNTHETIC-LOCAL-HTTP-API-PRIVATE';
  const input = {
    expectedRevision: 0,
    name: 'Local endpoint',
    type: 'streamable_http',
    url: 'http://localhost:8080/mcp',
    headers: { Authorization: `Bearer ${privateValue}` },
    autoSync: false,
    approveExecution: false,
    confirmSave: true,
  };
  const rejected = await f.server.app.inject({
    method: 'POST',
    url: '/api/connectors/manual',
    headers: f.headers,
    payload: input,
  });
  expect(rejected.statusCode).toBe(400);
  expect(rejected.body).not.toContain(privateValue);
  expect(f.secrets.values.size).toBe(0);
  expect((await f.lifecycle.inventory()).connectors).toEqual([]);
  const saved = await f.server.app.inject({
    method: 'POST',
    url: '/api/connectors/manual',
    headers: f.headers,
    payload: { ...input, localHttpOptIn: true },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({
    state: 'saved',
    requiresApproval: true,
  });
  const state = await f.lifecycle.inventory();
  expect(state.connectors[0]).toMatchObject({
    localHttpOptIn: true,
    endpoint: input.url,
    trustApproval: null,
  });
  expect(JSON.stringify([state, saved.json()])).not.toContain(privateValue);
});
