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
  const save = async (
    connectorId: string,
    name: string,
    override: Record<string, unknown> | null,
    revision?: number,
  ) =>
    server.app.inject({
      method: 'POST',
      url: `/api/connectors/${connectorId}/tool-override`,
      headers,
      payload: {
        expectedRevision: revision ?? (await f.hub.inventory()).revision,
        expectedConnectorRevision: 1,
        originalToolName: name,
        override: override
          ? { connectorId, originalToolName: name, ...override }
          : null,
      },
    });
  return { ...f, server, headers, save };
}
it('requires session/Origin/CSRF and rejects reserved, duplicate, original and generated-name collisions', async () => {
  const f = await setup(),
    input = {
      expectedRevision: (await f.hub.inventory()).revision,
      expectedConnectorRevision: 1,
      originalToolName: 'fixture_first',
      override: {
        connectorId: 'connector-0',
        originalToolName: 'fixture_first',
        alias: 'inspect_records',
      },
    };
  for (const headers of [
    { host: f.headers.host, origin: f.headers.origin },
    { ...f.headers, origin: 'https://foreign.test' },
    { ...f.headers, 'x-csrf-token': 'bad' },
  ])
    expect([401, 403]).toContain(
      (
        await f.server.app.inject({
          method: 'POST',
          url: '/api/connectors/connector-0/tool-override',
          headers,
          payload: input,
        })
      ).statusCode,
    );
  for (const alias of ['search_tools', 'call_tool'])
    expect(
      (await f.save('connector-0', 'fixture_first', { alias })).statusCode,
    ).toBe(400);
  expect(
    (
      await f.save('connector-0', 'fixture_first', {
        alias: 'connector-1__fixture_first',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await f.save('connector-0', 'fixture_first', { alias: 'fixture_second' }))
      .statusCode,
  ).toBe(409);
  expect(
    (await f.save('connector-0', 'fixture_first', { alias: 'inspect_records' }))
      .statusCode,
  ).toBe(200);
  expect(
    (await f.save('connector-1', 'fixture_first', { alias: 'inspect_records' }))
      .statusCode,
  ).toBe(400);
  expect(f.peers.flatMap((peer) => peer.methods)).not.toContain('tools/call');
});
it('persists overrides with CAS, exposes revised metadata and routes live HTTP calls through original-name policies', async () => {
  const f = await setup(),
    cursor = f.agents.get('cursor')!.client,
    revision = (await f.hub.inventory()).revision,
    before = f.fileEffects();
  expect(
    (
      await f.save(
        'connector-0',
        'fixture_first',
        {
          alias: 'inspect_records',
          customDescription: 'Find revenue invoices.',
          annotations: { readOnlyHint: true, title: 'Invoice inspector' },
        },
        revision,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await f.save('connector-0', 'fixture_first', null, revision)).statusCode,
  ).toBe(409);
  const tools = (await cursor.listTools()).tools;
  expect(tools.find((tool) => tool.name === 'inspect_records')).toMatchObject({
    description: 'Find revenue invoices.',
    annotations: { readOnlyHint: true, title: 'Invoice inspector' },
  });
  expect(
    await cursor.callTool({
      name: 'inspect_records',
      arguments: { literal: 'value' },
    }),
  ).not.toHaveProperty('isError', true);
  expect(
    await cursor.callTool({ name: 'connector-0__fixture_first' }),
  ).not.toHaveProperty('isError', true);
  await apply(f.hub, {
    kind: 'set_tool_policies',
    connectorId: 'connector-0',
    expectedConnectorRevision: 1,
    toolPolicies: { fixture_first: 'block' },
  });
  expect(await cursor.callTool({ name: 'inspect_records' })).toMatchObject({
    content: [{ text: 'tool_blocked' }],
  });
  expect(
    (await cursor.listTools()).tools.some(
      (tool) => tool.name === 'inspect_records',
    ),
  ).toBe(false);
  expect(f.fileEffects()).toEqual(before);
  expect(
    f.hub.requestLog
      .records()
      .every((record) => record.toolName === 'fixture_first'),
  ).toBe(true);
  expect(JSON.stringify(f.hub.requestLog.records())).not.toContain('revenue');
  expect((await f.save('connector-0', 'fixture_first', null)).statusCode).toBe(
    200,
  );
  expect((await f.hub.inventory()).toolOverrides).toEqual([]);
});
it('searches custom descriptions and aliases under profile restrictions, without a policy or scope bypass', async () => {
  const f = await setup(),
    cursor = f.agents.get('cursor')!.client;
  await f.save('connector-0', 'fixture_first', {
    alias: 'inspect_records',
    customDescription: 'Revenue invoice reconciliation.',
  });
  await apply(f.hub, {
    kind: 'set_agent_tool_search',
    agentId: 'cursor',
    toolSearchMode: true,
  });
  await apply(f.hub, {
    kind: 'set_agent_profile',
    agentId: 'cursor',
    profileId: 'profile',
  });
  const result = await cursor.callTool({
    name: 'search_tools',
    arguments: { query: 'invoice reconciliation' },
  });
  expect(
    (result.structuredContent as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    ),
  ).toEqual(['inspect_records']);
  expect(
    await cursor.callTool({
      name: 'call_tool',
      arguments: { name: 'inspect_records' },
    }),
  ).not.toHaveProperty('isError', true);
  await apply(f.hub, {
    kind: 'set_agent_profile',
    agentId: 'cursor',
    profileId: 'operations',
  });
  expect(
    await cursor.callTool({
      name: 'call_tool',
      arguments: { name: 'inspect_records' },
    }),
  ).toMatchObject({ content: [{ text: 'tool_scope_denied' }] });
});
