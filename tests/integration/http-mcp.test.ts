import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListResourcesRequestSchema,
  ResourceListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createHttpSessions,
  createManagedPeerFactory,
  definitionHash,
} from '@waleed/hub-core';
import { httpFixture } from '../helpers/http.js';
import { connector, profileState } from '../helpers/runtime.js';
import { mcpHttpFixture } from '../helpers/mcp-http.js';
import { isLoopbackPeer } from '../../apps/server/src/http-mcp.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  options: Parameters<typeof httpFixture>[0] = {},
  configuration: Parameters<typeof httpFixture>[1] = {},
) {
  const f = await httpFixture(options, configuration);
  cleanup.push(f.close);
  return f;
}
const headers = (secret: string, session?: string) => ({
  Authorization: `Bearer ${secret}`,
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
  ...(session ? { 'Mcp-Session-Id': session } : {}),
});
it('uses the SDK live Streamable HTTP initialize/tools/list/tools/call chain with metadata-only HTTP identity logs', async () => {
  const f = await fixture(),
    token = await f.token(),
    { client, transport } = await f.client(token.plaintextToken);
  expect(transport.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual(['connector-0__read']);
  expect(
    await client.callTool({
      name: 'connector-0__read',
      arguments: { value: 'SYNTHETIC-PRIVATE-ARGUMENT' },
    }),
  ).toMatchObject({ content: [{ text: 'synthetic success' }] });
  expect(f.calls).toHaveLength(1);
  const logs = f.hub.requestLogSnapshot();
  expect(logs.records[0]).toMatchObject({
    agentId: 'http-client',
    connectorId: 'connector-0',
    toolName: 'read',
    status: 'success',
  });
  const publicState = JSON.stringify({
    logs,
    state: await f.hub.inventory(),
    tokens: await f.hub.http.tokens.list(),
    safety: await f.hub.safety.read(),
  });
  for (const value of [
    token.plaintextToken,
    'SYNTHETIC-PRIVATE-ARGUMENT',
    transport.sessionId!,
  ])
    expect(publicState).not.toContain(value);
  await transport.terminateSession();
  const response = await fetch(f.url, {
    headers: headers(token.plaintextToken, transport.sessionId),
    method: 'GET',
  });
  expect([400, 404]).toContain(response.status);
});
it('requires Bearer on every method, rejects expired tokens/non-loopback peers and never trusts forwarded addresses', async () => {
  const f = await fixture(),
    token = await f.token(),
    { transport } = await f.client(token.plaintextToken);
  for (const method of ['POST', 'GET', 'DELETE'] as const) {
    const response = await f.server.app.inject({
      method,
      url: '/mcp',
      headers: {
        host: f.host,
        'mcp-session-id': transport.sessionId!,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST'
        ? { payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }
        : {}),
    });
    expect(response.statusCode).toBe(401);
  }
  for (const remoteAddress of ['192.0.2.11', '10.0.0.2', '::ffff:192.0.2.11']) {
    const response = await f.server.app.inject({
      method: 'GET',
      url: '/mcp',
      remoteAddress,
      headers: {
        host: f.host,
        ...headers(token.plaintextToken, transport.sessionId),
        'x-forwarded-for': '127.0.0.1',
      },
    });
    expect(response.statusCode).toBe(403);
  }
  const expires = await f.token({
    expiresAt: new Date(f.now() + 100).toISOString(),
  });
  f.advance(100);
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: '/mcp',
        headers: { host: f.host, ...headers(expires.plaintextToken) },
      })
    ).statusCode,
  ).toBe(401);
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    expect(isLoopbackPeer(address)).toBe(true);
  for (const address of [undefined, '127.0.0.2', '::', 'localhost'])
    expect(isLoopbackPeer(address)).toBe(false);
});
it('denies foreign Host/Origin, malformed/duplicate auth, path bypasses, session theft and URL credentials', async () => {
  const f = await fixture(),
    a = await f.token(),
    b = await f.token(),
    { transport } = await f.client(a.plaintextToken);
  const stolen = await fetch(f.url, {
    headers: headers(b.plaintextToken, transport.sessionId),
  });
  expect(stolen.status).toBe(404);
  for (const override of [
    { host: 'evil.test' },
    { origin: 'https://evil.test' },
    { 'sec-fetch-site': 'cross-site' },
  ])
    expect(
      (
        await f.server.app.inject({
          method: 'GET',
          url: '/mcp',
          headers: {
            host: f.host,
            ...headers(a.plaintextToken, transport.sessionId),
            ...override,
          },
        })
      ).statusCode,
    ).toBe(403);
  for (const authorization of [
    'Basic xxxx',
    `Bearer ${a.plaintextToken}, Bearer ${b.plaintextToken}`,
    'Bearer nope',
  ])
    expect(
      (
        await f.server.app.inject({
          method: 'GET',
          url: '/mcp',
          headers: { host: f.host, authorization },
        })
      ).statusCode,
    ).toBe(401);
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: `/mcp?token=${a.plaintextToken}`,
        headers: { host: f.host },
      })
    ).statusCode,
  ).toBe(401);
  for (const url of ['/mcp/', '/api/mcp', '/%6dcp'])
    expect(
      (
        await f.server.app.inject({
          method: 'POST',
          url,
          headers: { host: f.host, 'content-type': 'application/json' },
          payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
        })
      ).statusCode,
    ).not.toBe(200);
});
it('keeps token-management APIs behind browser session, Origin and CSRF rather than MCP Bearer credentials', async () => {
  const f = await fixture(),
    token = await f.token();
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: '/api/http-tokens',
        headers: { host: f.host, ...headers(token.plaintextToken) },
      })
    ).statusCode,
  ).toBe(401);
  const browser = await f.browser();
  for (const override of [
    { origin: 'https://evil.test' },
    { 'x-csrf-token': 'bad' },
  ])
    expect(
      (
        await f.server.app.inject({
          method: 'POST',
          url: '/api/http-tokens',
          headers: { ...browser, ...override },
          payload: { expectedRevision: 1, label: 'Denied' },
        })
      ).statusCode,
    ).toBe(403);
  const created = await f.server.app.inject({
    method: 'POST',
    url: '/api/http-tokens',
    headers: browser,
    payload: {
      expectedRevision: 1,
      label: 'Browser managed',
      profileId: 'profile',
    },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().plaintextToken).toMatch(/^wmh_live_/);
  const listed = await f.server.app.inject({
    method: 'GET',
    url: '/api/http-tokens',
    headers: browser,
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.body).not.toContain(created.json().plaintextToken);
  expect(listed.body).not.toContain('hash');
  const revoke = await f.server.app.inject({
    method: 'DELETE',
    url: `/api/http-tokens/${created.json().token.id}`,
    headers: browser,
    payload: { expectedRevision: 2 },
  });
  expect(revoke.statusCode).toBe(200);
  expect(revoke.json().tokens[1].revokedAt).toBeDefined();
  expect(
    (
      await f.server.app.inject({
        method: 'DELETE',
        url: `/api/http-tokens/${token.token.id}`,
        headers: { ...browser, 'x-csrf-token': 'bad' },
        payload: { expectedRevision: 3 },
      })
    ).statusCode,
  ).toBe(403);
});
it('intersects token profiles with live agent restrictions and preserves tool-search mode without widening the agent', async () => {
  const f = await fixture();
  const state = await f.store.read();
  state.connectors.push(connector('connector-1', 'native'));
  state.profiles[0]!.connectorIds = ['connector-0'];
  state.profiles.push({
    ...state.profiles[0]!,
    id: 'token-scope',
    name: 'Token scope',
    connectorIds: ['connector-0', 'connector-1'],
  });
  state.agentProfileBindings = { cursor: 'profile' };
  state.agentToolSearchModes = { cursor: true };
  await f.store.write(state.revision, {
    ...state,
    revision: state.revision + 1,
  });
  const token = await f.token({ agentId: 'cursor', profileId: 'token-scope' }),
    { client } = await f.client(token.plaintextToken);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    'search_tools',
    'call_tool',
  ]);
  const search = await client.callTool({
    name: 'search_tools',
    arguments: { query: 'read' },
  });
  expect(
    (search.structuredContent as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    ),
  ).toEqual(['connector-0__read']);
  expect(
    await client.callTool({
      name: 'call_tool',
      arguments: { name: 'connector-0__read' },
    }),
  ).not.toHaveProperty('isError', true);
  const live = await f.store.read();
  live.agentProfileBindings = { cursor: 'missing' };
  await f.store.write(live.revision, { ...live, revision: live.revision + 1 });
  expect(
    await client.callTool({
      name: 'call_tool',
      arguments: { name: 'connector-0__read' },
    }),
  ).toMatchObject({ isError: true });
  expect(f.calls).toHaveLength(1);
  expect(f.hub.requestLogSnapshot().records[0]!.agentId).toBe('cursor');
});
it.each(['missing', 'disabled', 'narrowed'] as const)(
  'fails closed when a token profile becomes %s after a handle was advertised',
  async (change) => {
    const f = await fixture(),
      token = await f.token({ profileId: 'profile' }),
      { client } = await f.client(token.plaintextToken);
    await client.listTools();
    const state = await f.store.read();
    if (change === 'missing') state.profiles = [];
    else if (change === 'disabled') state.profiles[0]!.enabled = false;
    else state.profiles[0]!.connectorIds = [];
    await f.store.write(state.revision, {
      ...state,
      revision: state.revision + 1,
    });
    expect(await client.callTool({ name: 'connector-0__read' })).toMatchObject({
      isError: true,
    });
    expect((await client.listTools()).tools).toEqual([]);
    expect(f.calls).toHaveLength(0);
  },
);
it.each(['ask', 'block', 'allow'] as const)(
  'enforces %s policies over HTTP with no implicit execution consent',
  async (policy) => {
    const f = await fixture(),
      state = await f.store.read();
    state.connectors[0]!.toolPolicies = { read: policy };
    await f.store.write(state.revision, {
      ...state,
      revision: state.revision + 1,
    });
    const token = await f.token(),
      { client } = await f.client(token.plaintextToken),
      tools = await client.listTools();
    expect(tools.tools.length).toBe(policy === 'block' ? 0 : 1);
    const result = await client.callTool({ name: 'connector-0__read' });
    expect(result.isError === true).toBe(policy !== 'allow');
    expect(f.calls.length).toBe(policy === 'allow' ? 1 : 0);
  },
);
it('revocation closes SSE and pending calls, suppresses delayed results and does not affect another token', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    called = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const f = await fixture({ callGate: gate, onCall: entered }),
    token = await f.token(),
    other = await f.token(),
    { client, transport } = await f.client(token.plaintextToken);
  await client.listTools();
  expect(transport.sessionId).toBeDefined();
  const initialize = await fetch(f.url, {
    method: 'POST',
    headers: headers(token.plaintextToken),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'raw-sse-client', version: '1' },
      },
    }),
  });
  expect(initialize.status).toBe(200);
  const rawSession = initialize.headers.get('mcp-session-id')!;
  await initialize.json();
  const controller = new AbortController();
  cleanup.push(async () => controller.abort());
  const stream = await fetch(f.url, {
    headers: {
      ...headers(token.plaintextToken, rawSession),
      Accept: 'text/event-stream',
    },
    signal: controller.signal,
  });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  // The SDK's keep-alive proves this GET is a live SSE stream, not JSON polling.
  await reader.read();
  const pending = client.callTool({ name: 'connector-0__read' }).then(
    (value) => ({ value }),
    () => ({ closed: true }),
  );
  await called;
  await f.hub.http.tokens.revoke(token.token.id, {
    expectedRevision: (await f.hub.http.tokens.list()).revision,
  });
  release();
  expect(await pending).toMatchObject({ closed: true });
  const closed = await reader.read();
  expect(closed.done).toBe(true);
  expect(
    await f.hub.http.tokens.authenticate(token.plaintextToken),
  ).toBeUndefined();
  expect(
    (await (await f.client(other.plaintextToken)).client.listTools()).tools,
  ).toHaveLength(1);
  expect(f.peers.closed).toBeGreaterThanOrEqual(1);
}, 30_000);
it('forwards resources and prompts over the HTTP endpoint through the existing managed peer factory', async () => {
  const upstream = await mcpHttpFixture();
  cleanup.push(upstream.close);
  const state = profileState(['remote']),
    item = state.connectors[0]!;
  if (item.executionMode !== 'remote') throw new Error();
  item.endpoint = `${upstream.origin}/mcp`;
  item.localHttpOptIn = true;
  item.trustApproval!.definitionHash = definitionHash(item);
  const f = await fixture(
    {},
    {
      state,
      connect: createManagedPeerFactory('unused-http-content', async () =>
        structuredClone(state),
      ),
    },
  );
  const token = await f.token({ profileId: 'profile' }),
    { client } = await f.client(token.plaintextToken);
  const resources = await client.listResources();
  expect(resources.resources.length).toBeGreaterThan(0);
  expect(
    (await client.readResource({ uri: resources.resources[0]!.uri })).contents
      .length,
  ).toBeGreaterThan(0);
  const prompts = await client.listPrompts();
  expect(prompts.prompts.length).toBeGreaterThan(0);
  expect(
    (await client.getPrompt({ name: prompts.prompts[0]!.name })).messages
      .length,
  ).toBeGreaterThan(0);
});
it('bounds sessions, releases capacity after DELETE, expires idle sessions and cancels on shutdown', async () => {
  const f = await fixture(),
    token = await f.token(),
    pool = createHttpSessions(f.hub.http, Date.now, {
      total: 2,
      perToken: 1,
      idleMs: 30,
      lifetimeMs: 200,
    });
  cleanup.push(() => pool.close());
  const session = await pool.acquire(token.token, undefined, true);
  await expect(
    pool.acquire(token.token, undefined, true),
  ).rejects.toHaveProperty('code', 'busy');
  await session.close();
  const next = await pool.acquire(token.token, undefined, true);
  await next.close();
  const expired = await pool.acquire(token.token, undefined, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(expired.transport.sessionId).toBeUndefined();
  // A reserved but never-initialized session is removed by idle cleanup.
  const fresh = await pool.acquire(token.token, undefined, true);
  await fresh.close();
});
it('closes initialized sessions at token expiry without waiting for another HTTP request', async () => {
  const f = await fixture(),
    token = await f.token({ expiresAt: new Date(f.now() + 300).toISOString() }),
    { client } = await f.client(token.plaintextToken);
  await client.listTools();
  expect(f.peers.started).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(f.peers.closed).toBe(1);
  await expect(client.listTools()).rejects.toThrow();
  f.advance(500);
  expect(
    await f.hub.http.tokens.authenticate(token.plaintextToken),
  ).toBeUndefined();
});
it('records Bearer/loopback refusals as bounded structural metadata, never request headers or session IDs', async () => {
  const f = await fixture(),
    token = await f.token();
  await f.server.app.inject({
    method: 'GET',
    url: '/mcp?private=SYNTHETIC-PRIVATE-QUERY',
    headers: { host: f.host, authorization: 'Bearer SYNTHETIC-PRIVATE-AUTH' },
  });
  await f.server.app.inject({
    method: 'GET',
    url: '/mcp',
    remoteAddress: '192.0.2.1',
    headers: { host: f.host, ...headers(token.plaintextToken) },
  });
  const safety = await f.hub.safety.read();
  expect(
    safety.securityEvents.map((entry) => ({
      route: entry.route,
      reason: entry.reason,
    })),
  ).toEqual(
    expect.arrayContaining([
      { route: 'http_mcp', reason: 'bearer_required' },
      { route: 'http_mcp', reason: 'loopback_required' },
    ]),
  );
  for (const value of [
    token.plaintextToken,
    'SYNTHETIC-PRIVATE-QUERY',
    'SYNTHETIC-PRIVATE-AUTH',
  ])
    expect(JSON.stringify(safety)).not.toContain(value);
});
it('delivers upstream MCP list-changed notifications over the authenticated GET SSE stream', async () => {
  const upstream: Server[] = [];
  const f = await fixture(
    {},
    {
      connect: async () => {
        const server = new Server(
          { name: 'synthetic-sse-content', version: '1' },
          { capabilities: { resources: { listChanged: true } } },
        );
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: [{ name: 'fixture', uri: 'fixture://sse' }],
        }));
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(a);
        const client = new Client(
          { name: 'synthetic-sse-peer', version: '1' },
          { capabilities: {} },
        );
        await client.connect(b);
        upstream.push(server);
        return {
          client,
          assertPublic() {},
          async dispose() {
            await client.close();
            await server.close();
          },
        };
      },
    },
  );
  const token = await f.token(),
    { client } = await f.client(token.plaintextToken);
  let notifications = 0;
  client.setNotificationHandler(
    ResourceListChangedNotificationSchema,
    async () => {
      notifications++;
    },
  );
  expect((await client.listResources()).resources).toHaveLength(1);
  await upstream[0]!.notification({
    method: 'notifications/resources/list_changed',
  });
  await expect.poll(() => notifications).toBe(1);
});
