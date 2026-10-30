import { afterEach, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import { toolPolicyFixture } from '../helpers/tool-policies.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const f = await toolPolicyFixture(),
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
    });
  const headers = {
    ...base,
    cookie: session.headers['set-cookie']!.toString().split(';')[0]!,
    'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
  };
  const save = async (policies: Record<string, string>, revision?: number) =>
    server.app.inject({
      method: 'POST',
      url: '/api/connectors/connector-0/tool-policies',
      headers,
      payload: {
        expectedRevision: revision ?? (await f.hub.inventory()).revision,
        expectedConnectorRevision: 1,
        toolPolicies: policies,
      },
    });
  return { ...f, server, headers, save };
}
it('protects tool policy mutations with session/Origin/CSRF and rejects dangerous keys', async () => {
  const f = await setup(),
    url = '/api/connectors/connector-0/tool-policies',
    payload = {
      expectedRevision: 0,
      expectedConnectorRevision: 1,
      toolPolicies: { fixture_first: 'block' },
    };
  for (const headers of [
    { host: f.headers.host, origin: f.headers.origin },
    { ...f.headers, 'x-csrf-token': 'bad' },
    { ...f.headers, origin: 'https://foreign.test' },
  ])
    expect([401, 403]).toContain(
      (await f.server.app.inject({ method: 'POST', url, headers, payload }))
        .statusCode,
    );
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const response = await f.server.app.inject({
      method: 'POST',
      url,
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...payload,
        toolPolicies: JSON.parse(`{"${key}":"block"}`),
      }),
    });
    expect(response.statusCode).toBe(400);
  }
  expect((await f.hub.inventory()).revision).toBe(0);
});
it('applies journaled revision-safe policies to a live real HTTP MCP bridge, including cached handles and Ask confirmation', async () => {
  const f = await setup();
  await f.agent.listTools();
  expect(
    (await f.save({ fixture_first: 'block', fixture_second: 'ask' }))
      .statusCode,
  ).toBe(200);
  const catalog = await f.agent.listTools();
  expect(catalog.tools.map((tool) => tool.name)).not.toContain(
    'connector-0__fixture_first',
  );
  const before = f.peer.methods.filter(
    (method) => method === 'tools/call',
  ).length;
  expect(
    await f.agent.callTool({ name: 'connector-0__fixture_first' }),
  ).toMatchObject({ isError: true, content: [{ text: 'tool_blocked' }] });
  expect(
    await f.agent.callTool({ name: 'connector-0__fixture_second' }),
  ).toHaveProperty('isError', true);
  expect(f.prompts()).toBe(1);
  expect(
    f.peer.methods.filter((method) => method === 'tools/call'),
  ).toHaveLength(before);
  f.setAnswer({ action: 'accept', content: { approve: true } });
  expect(
    await f.agent.callTool({ name: 'connector-0__fixture_second' }),
  ).not.toHaveProperty('isError', true);
  expect(f.prompts()).toBe(2);
  expect(
    f.peer.methods.filter((method) => method === 'tools/call'),
  ).toHaveLength(before + 1);
  expect((await f.save({}, 0)).statusCode).toBe(409);
  expect((await f.hub.inventory()).connectors[0]!.toolPolicies).toEqual({
    fixture_first: 'block',
    fixture_second: 'ask',
  });
  expect((await f.hub.checks.observations())[0]!.tools).toHaveLength(3);
  expect((await f.save({})).statusCode).toBe(200);
  await f.agent.listTools();
  expect(
    await f.agent.callTool({ name: 'connector-0__fixture_first' }),
  ).not.toHaveProperty('isError', true);
  expect(f.prompts()).toBe(2);
});
