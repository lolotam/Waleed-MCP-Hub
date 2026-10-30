import { afterEach, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import { agentProfilesFixture } from '../helpers/agent-profiles.js';
import { apply } from '../helpers/runtime.js';
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
  const toggle = async (
    agentId: string,
    toolSearchMode: boolean,
    revision?: number,
  ) =>
    server.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/tool-search`,
      headers,
      payload: {
        expectedRevision: revision ?? (await f.hub.inventory()).revision,
        toolSearchMode,
      },
    });
  return { ...f, server, headers, toggle };
}
it('guards the mode toggle with session/Origin/CSRF, validates booleans and rejects unknown agent IDs', async () => {
  const f = await setup(),
    revision = (await f.hub.inventory()).revision,
    url = '/api/agents/cursor/tool-search',
    payload = { expectedRevision: revision, toolSearchMode: true };
  for (const headers of [
    { host: f.headers.host, origin: f.headers.origin },
    { ...f.headers, 'x-csrf-token': 'bad' },
    { ...f.headers, origin: 'https://foreign.test' },
  ])
    expect([401, 403]).toContain(
      (await f.server.app.inject({ method: 'POST', url, headers, payload }))
        .statusCode,
    );
  expect((await f.toggle('unknown', true)).statusCode).toBe(400);
  expect(
    (
      await f.server.app.inject({
        method: 'POST',
        url,
        headers: f.headers,
        payload: { ...payload, toolSearchMode: 'true' },
      })
    ).statusCode,
  ).toBe(400);
  expect((await f.hub.inventory()).revision).toBe(revision);
});
it('toggles two-tool catalogs per agent, searches/calls a real HTTP MCP and preserves default catalogs without file changes', async () => {
  const f = await setup(),
    cursor = f.agents.get('cursor')!.client,
    codex = f.agents.get('codex')!.client,
    before = f.fileEffects();
  expect((await f.toggle('cursor', true)).statusCode).toBe(200);
  const methods = f.peers.map((peer) => peer.methods.length);
  expect((await cursor.listTools()).tools.map((tool) => tool.name)).toEqual([
    'search_tools',
    'call_tool',
  ]);
  expect(f.peers.map((peer) => peer.methods.length)).toEqual(methods);
  expect((await codex.listTools()).tools).toHaveLength(6);
  const result = await cursor.callTool({
      name: 'search_tools',
      arguments: { query: 'fixture_first' },
    }),
    tools = (
      result.structuredContent as {
        tools: Array<{ name: string; inputSchema: unknown }>;
      }
    ).tools;
  expect(tools).toHaveLength(2);
  expect(tools[0]).toHaveProperty('inputSchema');
  expect(
    await cursor.callTool({
      name: 'call_tool',
      arguments: { name: tools[0]!.name, arguments: { literal: 'value' } },
    }),
  ).not.toHaveProperty('isError', true);
  expect(
    f.peers
      .flatMap((peer) => peer.methods)
      .filter((method) => method === 'tools/call'),
  ).toHaveLength(1);
  expect(f.fileEffects()).toEqual(before);
  expect(
    (await f.hub.integrations.toolSets()).toolSets.find(
      (item) => item.agentId === 'cursor',
    )?.toolSearchMode,
  ).toBe(true);
  expect((await f.toggle('cursor', false)).statusCode).toBe(200);
  expect((await cursor.listTools()).tools).toHaveLength(6);
  expect(
    await cursor.callTool({
      name: 'call_tool',
      arguments: { name: tools[0]!.name },
    }),
  ).toMatchObject({ content: [{ text: 'tool_search_disabled' }] });
});
it('applies profile and per-tool permissions to searched handles and refuses stale revision saves', async () => {
  const f = await setup(),
    cursor = f.agents.get('cursor')!.client,
    revision = (await f.hub.inventory()).revision;
  expect((await f.toggle('cursor', true, revision)).statusCode).toBe(200);
  expect((await f.toggle('codex', true, revision)).statusCode).toBe(409);
  await apply(f.hub, {
    kind: 'set_agent_profile',
    agentId: 'cursor',
    profileId: 'profile',
  });
  await apply(f.hub, {
    kind: 'set_tool_policies',
    connectorId: 'connector-0',
    expectedConnectorRevision: 1,
    toolPolicies: { fixture_first: 'block', fixture_second: 'ask' },
  });
  const result = await cursor.callTool({
    name: 'search_tools',
    arguments: { query: 'fixture' },
  });
  expect(
    (result.structuredContent as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    ),
  ).toEqual(['connector-0__fixture_second']);
  expect(
    await cursor.callTool({
      name: 'call_tool',
      arguments: { name: 'connector-0__fixture_first' },
    }),
  ).toMatchObject({ content: [{ text: 'tool_blocked' }] });
  expect(
    await cursor.callTool({
      name: 'call_tool',
      arguments: { name: 'connector-0__fixture_second' },
    }),
  ).toMatchObject({ content: [{ text: 'tool_approval_required' }] });
  expect(
    await cursor.callTool({
      name: 'call_tool',
      arguments: { name: 'connector-1__fixture_first' },
    }),
  ).toMatchObject({ content: [{ text: 'tool_scope_denied' }] });
  expect(f.peers.flatMap((peer) => peer.methods)).not.toContain('tools/call');
});
