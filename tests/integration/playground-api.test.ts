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
  const post = (url: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url, headers, payload });
  return { ...f, server, headers, post };
}
it('protects all Playground/log APIs with session, Origin and CSRF and keeps refusal audits payload-free', async () => {
  const f = await setup(),
    input = {
      connectorId: 'connector-0',
      toolName: 'fixture_first',
      confirmExecute: true,
      arguments: { token: 'SYNTHETIC-API-PRIVATE' },
    };
  for (const url of [
    '/api/playground/catalog',
    '/api/playground/invoke',
    '/api/playground/jobs/unknown/cancel',
  ])
    for (const headers of [
      { host: f.headers.host, origin: f.headers.origin },
      { ...f.headers, origin: 'https://foreign.test' },
      { ...f.headers, 'x-csrf-token': 'bad' },
    ])
      expect([401, 403]).toContain(
        (
          await f.server.app.inject({
            method: 'POST',
            url,
            headers,
            payload: input,
          })
        ).statusCode,
      );
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: '/api/request-log',
        headers: { host: f.headers.host },
      })
    ).statusCode,
  ).toBe(401);
  for (const confirmExecute of [undefined, false, 'true'])
    expect(
      (await f.post('/api/playground/invoke', { ...input, confirmExecute }))
        .statusCode,
    ).toBe(400);
  expect(f.peers.flatMap((peer) => peer.methods)).not.toContain('tools/call');
  expect(JSON.stringify(await f.hub.safety.read())).not.toContain(
    'SYNTHETIC-API-PRIVATE',
  );
});
it('runs a reviewed HTTP MCP tool once, displays bounded output and aggregates agent/Playground records', async () => {
  const f = await setup(),
    catalog = (
      await f.post('/api/playground/catalog', { connectorId: 'connector-0' })
    ).json(),
    tool = catalog.tools.find(
      (tool: { name: string }) => tool.name === 'fixture_first',
    );
  expect(f.peers.flatMap((peer) => peer.methods)).not.toContain('tools/call');
  const started = await f.post('/api/playground/invoke', {
    connectorId: catalog.connectorId,
    toolName: tool.name,
    arguments: { token: 'SYNTHETIC-ARG-NOT-LOGGED' },
    confirmExecute: true,
    expectedRevision: catalog.revision,
    expectedConnectorRevision: catalog.connectorRevision,
    expectedDefinitionHash: catalog.definitionHash,
    expectedToolSchemaHash: tool.schemaHash,
  });
  expect(started.statusCode).toBe(200);
  await f.hub.playground.drain();
  const result = await f.server.app.inject({
    method: 'GET',
    url: `/api/playground/jobs/${started.json().id}`,
    headers: f.headers,
  });
  expect(result.json()).toMatchObject({
    state: 'succeeded',
    result: {
      output: expect.stringContaining('Synthetic fixture_first execution'),
    },
  });
  const agent = f.agents.get('cursor')!.client;
  await agent.listTools();
  await agent.callTool({
    name: 'connector-0__fixture_first',
    arguments: { value: 'SYNTHETIC-AGENT-PRIVATE' },
  });
  const response = await f.server.app.inject({
      method: 'GET',
      url: '/api/request-log',
      headers: f.headers,
    }),
    logs = response.json();
  expect(logs.records).toHaveLength(2);
  expect(
    logs.records.map((record: { agentId: string }) => record.agentId),
  ).toEqual(['cursor', 'hub_playground']);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.stringify(logs)).not.toContain('SYNTHETIC');
  expect(JSON.stringify(logs)).not.toContain('execution');
  const other = await f.server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host: f.headers.host, origin: f.headers.origin },
      payload: { token: f.server.issueLaunchToken() },
    }),
    foreign = {
      ...f.headers,
      cookie: other.headers['set-cookie']!.toString().split(';')[0]!,
    };
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: `/api/playground/jobs/${started.json().id}`,
        headers: foreign,
      })
    ).statusCode,
  ).toBe(404);
});
it('refuses a stale reviewed schema/registry and enforces Block without forwarding', async () => {
  const f = await setup(),
    catalog = (
      await f.post('/api/playground/catalog', { connectorId: 'connector-0' })
    ).json();
  await apply(f.hub, {
    kind: 'set_tool_policies',
    connectorId: 'connector-0',
    expectedConnectorRevision: 1,
    toolPolicies: { fixture_first: 'block' },
  });
  for (const toolName of ['fixture_first', 'fixture_second']) {
    const started = (
      await f.post('/api/playground/invoke', {
        connectorId: 'connector-0',
        toolName,
        confirmExecute: true,
        expectedRevision: catalog.revision,
      })
    ).json();
    await f.hub.playground.drain();
    expect(
      f.hub.playground.job(started.id, f.headers.cookie.split('=')[1]!).state,
    ).toBe('failed');
  }
  expect(f.peers.flatMap((peer) => peer.methods)).not.toContain('tools/call');
});
