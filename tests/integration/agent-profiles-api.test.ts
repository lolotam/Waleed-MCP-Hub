import { afterEach, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import { agentProfilesFixture } from '../helpers/agent-profiles.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const f = await agentProfilesFixture(),
    server = await createHubServer({ port: 4177, lifecycle: f.hub });
  cleanup.push(async () => {
    await server.app.close();
    await f.close(false);
  });
  const base = { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' },
    session = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: base,
      payload: { token: server.issueLaunchToken() },
    }),
    headers = {
      ...base,
      cookie: session.headers['set-cookie']!.toString().split(';')[0]!,
      'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
    };
  const assign = async (
    agentId: string,
    profileId: string | null,
    revision?: number,
  ) =>
    server.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/profile`,
      headers,
      payload: {
        expectedRevision: revision ?? (await f.hub.inventory()).revision,
        profileId,
      },
    });
  return { ...f, server, headers, assign };
}
it('guards profile mapping writes with session, Origin and CSRF; validates IDs and referenced profiles', async () => {
  const f = await setup(),
    revision = (await f.hub.inventory()).revision,
    url = '/api/agents/cursor/profile',
    payload = { expectedRevision: revision, profileId: 'profile' };
  for (const headers of [
    { host: f.headers.host, origin: f.headers.origin },
    { ...f.headers, 'x-csrf-token': 'bad' },
    { ...f.headers, origin: 'https://foreign.test' },
  ])
    expect([401, 403]).toContain(
      (await f.server.app.inject({ method: 'POST', url, headers, payload }))
        .statusCode,
    );
  expect((await f.assign('constructor', 'profile')).statusCode).toBe(400);
  expect((await f.assign('unknown', 'profile')).statusCode).toBe(400);
  expect((await f.assign('cursor', '../profile')).statusCode).toBe(400);
  expect((await f.assign('cursor', 'missing')).statusCode).toBe(404);
  expect((await f.hub.inventory()).revision).toBe(revision);
});
it('maps two real MCP bridge catalogs independently without changing agent files or starting a connector for counts', async () => {
  const f = await setup(),
    cursor = f.agents.get('cursor')!.client,
    codex = f.agents.get('codex')!.client,
    effects = f.fileEffects();
  expect((await cursor.listTools()).tools).toHaveLength(6);
  expect((await codex.listTools()).tools).toHaveLength(6);
  expect((await f.assign('cursor', 'profile')).statusCode).toBe(200);
  expect((await f.assign('codex', 'operations')).statusCode).toBe(200);
  const first = await cursor.listTools(),
    second = await codex.listTools();
  expect(first.tools).toHaveLength(3);
  expect(
    first.tools.every((tool) => tool.name.startsWith('connector-0__')),
  ).toBe(true);
  expect(
    second.tools.every((tool) => tool.name.startsWith('connector-1__')),
  ).toBe(true);
  const before = f.peers.map((peer) => peer.methods.length),
    sets = await f.server.app.inject({
      url: '/api/agents/tool-sets',
      headers: f.headers,
    });
  expect(sets.statusCode).toBe(200);
  expect(
    sets
      .json()
      .toolSets.find((item: { agentId: string }) => item.agentId === 'cursor'),
  ).toMatchObject({
    profileId: 'profile',
    connectorCount: 1,
    toolCount: 3,
    unverifiedConnectorCount: 0,
  });
  expect(f.peers.map((peer) => peer.methods.length)).toEqual(before);
  const callsBefore = f.peers.map(
    (peer) => peer.methods.filter((method) => method === 'tools/call').length,
  );
  expect(
    await cursor.callTool({ name: 'connector-1__fixture_first' }),
  ).toHaveProperty('isError', true);
  expect(
    await codex.callTool({ name: 'connector-0__fixture_first' }),
  ).toHaveProperty('isError', true);
  expect(
    f.peers.map(
      (peer) => peer.methods.filter((method) => method === 'tools/call').length,
    ),
  ).toEqual(callsBefore);
  expect(
    await cursor.callTool({ name: 'connector-0__fixture_first' }),
  ).not.toHaveProperty('isError', true);
  expect(f.fileEffects()).toEqual(effects);
  expect((await f.assign('cursor', null)).statusCode).toBe(200);
  expect((await cursor.listTools()).tools).toHaveLength(6);
  expect((await codex.listTools()).tools).toHaveLength(3);
});
it('rejects a stale full-map save and retains assignments across disconnect/reintegration', async () => {
  const f = await setup(),
    revision = (await f.hub.inventory()).revision;
  expect((await f.assign('cursor', 'profile', revision)).statusCode).toBe(200);
  expect((await f.assign('codex', 'operations', revision)).statusCode).toBe(
    409,
  );
  expect((await f.hub.inventory()).agentProfileBindings).toEqual({
    cursor: 'profile',
  });
  const status = await f.hub.integrations.status('cursor');
  await f.hub.integrations.disconnect('cursor', {
    expectedRevision: (await f.hub.inventory()).revision,
    fingerprint: status.fingerprint,
    confirmConfigurationChange: true,
  });
  expect((await f.hub.inventory()).agentProfileBindings).toEqual({
    cursor: 'profile',
  });
  const rescan = await f.hub.integrations.scan(),
    agent = rescan.agents.find((agent) => agent.agentId === 'cursor')!;
  await f.hub.integrations.integrate('cursor', {
    expectedRevision: (await f.hub.inventory()).revision,
    fingerprint: agent.fingerprint,
    confirmConfigurationChange: true,
  });
  expect((await f.agents.get('cursor')!.client.listTools()).tools).toHaveLength(
    3,
  );
  expect([...f.sources.values()].some((text) => text.includes('cursor'))).toBe(
    true,
  );
});
