import { afterEach, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ElicitRequestSchema,
  type ElicitResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  SearchToolsArgumentsSchema,
  SearchToolsResultSchema,
  CallToolArgumentsSchema,
  AgentToolSearchModesSchema,
  StateSchema,
  type HubState,
} from '@waleed/contracts';
import {
  createAgentBridge,
  createLifecycle,
  createMemorySafetyLedger,
  approved,
} from '@waleed/hub-core';
import { assertNoCredentialEcho } from '../packages/hub-core/src/integrations/bridge.js';
import { profileState, apply } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const tool = (
  name: string,
  description = 'Synthetic tool',
  extra: Partial<Tool> = {},
): Tool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  ...extra,
});
async function setup(
  options: {
    enabled?: boolean;
    state?: HubState;
    tools?: Record<string, Tool[]>;
    confirm?: () => Promise<ElicitResult>;
    listGate?: Promise<void>;
    listed?: () => void;
    secret?: string;
    echo?: boolean;
  } = {},
) {
  const state = options.state ?? profileState(['native', 'native']);
  if (options.enabled !== false) state.agentToolSearchModes = { cursor: true };
  const starts: string[] = [],
    calls: Array<{ id: string; name: string; arguments: unknown }> = [],
    prompts: unknown[] = [];
  const bridge = createAgentBridge(
    async () => structuredClone(state),
    async (connector) => {
      starts.push(connector.id);
      const server = new Server(
        { name: 'synthetic-search-peer', version: '1' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        options.listed?.();
        await options.listGate;
        return {
          tools: options.tools?.[connector.id] ?? [
            tool('read', 'Read records', {
              _meta: { keywords: ['inspect', 'query'] },
              annotations: { readOnlyHint: true },
            }),
            tool('write', 'Change records'),
          ],
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push({
          id: connector.id,
          name: request.params.name,
          arguments: request.params.arguments,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: options.echo ? options.secret! : 'synthetic success',
            },
          ],
        };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client(
        { name: 'synthetic-search-hub', version: '1' },
        { capabilities: {} },
      );
      await client.connect(b);
      return {
        client,
        assertPublic(value: unknown) {
          if (options.secret) assertNoCredentialEcho(value, [options.secret]);
        },
        async dispose() {
          await client.close();
          await server.close();
        },
      };
    },
    'cursor',
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'synthetic-search-agent', version: '1' },
    { capabilities: options.confirm ? { elicitation: { form: {} } } : {} },
  );
  if (options.confirm)
    agent.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request);
      return options.confirm!();
    });
  await agent.connect(b);
  cleanup.push(async () => {
    await agent.close();
    await bridge.close();
  });
  const search = async (query: string, limit?: number) => {
    const result = await agent.callTool({
      name: 'search_tools',
      arguments: { query, ...(limit === undefined ? {} : { limit }) },
    });
    return SearchToolsResultSchema.parse(result.structuredContent);
  };
  const call = (name: string, args?: Record<string, unknown>) =>
    agent.callTool({
      name: 'call_tool',
      arguments: { name, ...(args ? { arguments: args } : {}) },
    });
  return { state, agent, bridge, starts, calls, prompts, search, call };
}
it('advertises exactly two compact meta-tools without discovering or starting peers', async () => {
  const f = await setup(),
    catalog = await f.agent.listTools();
  expect(catalog.tools.map((tool) => tool.name)).toEqual([
    'search_tools',
    'call_tool',
  ]);
  expect(JSON.stringify(catalog).length).toBeLessThan(2200);
  expect(f.starts).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('preserves standard catalogs and direct calls when the optional mode is absent', async () => {
  const f = await setup({ enabled: false });
  expect(StateSchema.parse(f.state)).not.toHaveProperty('agentToolSearchModes');
  expect((await f.agent.listTools()).tools).toHaveLength(4);
  expect(await f.agent.callTool({ name: 'connector-0__read' })).toMatchObject({
    content: [{ text: 'synthetic success' }],
  });
  expect(
    await f.agent.callTool({
      name: 'search_tools',
      arguments: { query: 'read' },
    }),
  ).toMatchObject({ content: [{ text: 'tool_search_disabled' }] });
});
it('ranks exact tool names above partial names, titles, keywords and descriptions', async () => {
  const f = await setup({
    tools: {
      'connector-0': [
        tool('search_documents'),
        tool('documents'),
        tool('description_only', 'Find documents'),
        tool('keyword_only', 'Archive tool', {
          _meta: { keywords: ['documents', 'archive'] },
        }),
        tool('title_only', 'Title tool', { title: 'Documents management' }),
      ],
      'connector-1': [],
    },
  });
  const result = await f.search('DOCUMENTS');
  expect(result.tools.map((tool) => tool.name)).toEqual([
    'connector-0__documents',
    'connector-0__search_documents',
    'connector-0__title_only',
    'connector-0__keyword_only',
    'connector-0__description_only',
  ]);
  expect(result.tools[0]!.inputSchema).toMatchObject({
    properties: { value: { type: 'string' } },
  });
  expect(
    (await f.search('documents archive')).tools.map((tool) => tool.name),
  ).toEqual(['connector-0__keyword_only']);
  expect((await f.search('ＤＯＣＵＭＥＮＴＳ')).tools).toHaveLength(5);
  expect((await f.search('.*')).tools).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('returns results beyond the legacy 256-tool catalog limit without advertising their schemas initially', async () => {
  const f = await setup({
    tools: {
      'connector-0': Array.from({ length: 600 }, (_, index) =>
        tool(`item_${String(index).padStart(4, '0')}`),
      ),
      'connector-1': [],
    },
  });
  expect((await f.agent.listTools()).tools).toHaveLength(2);
  const result = await f.search('item_0599');
  expect(result.tools.map((tool) => tool.name)).toEqual([
    'connector-0__item_0599',
  ]);
  expect(
    await f.call(result.tools[0]!.name, { value: 'literal' }),
  ).toMatchObject({ content: [{ text: 'synthetic success' }] });
  expect(f.calls).toEqual([
    { id: 'connector-0', name: 'item_0599', arguments: { value: 'literal' } },
  ]);
});
it('defaults search limits to ten, supports fifty, and reports additional matches', async () => {
  const f = await setup({
    tools: {
      'connector-0': Array.from({ length: 60 }, (_, index) =>
        tool(`item_${index}`),
      ),
      'connector-1': [],
    },
  });
  expect((await f.search('item')).tools).toHaveLength(10);
  const result = await f.search('item', 50);
  expect(result.tools).toHaveLength(50);
  expect(result.hasMore).toBe(true);
  expect(result.truncated).toBe(false);
});
it('never returns Block metadata and refuses call_tool with tool_blocked', async () => {
  const state = profileState(['native', 'native']);
  state.connectors[0]!.toolPolicies = { read: 'block' };
  const f = await setup({ state });
  const result = await f.search('read');
  expect(result.tools.map((tool) => tool.name)).toEqual(['connector-1__read']);
  expect(await f.call('connector-0__read')).toMatchObject({
    isError: true,
    structuredContent: { error: 'tool_blocked' },
  });
  expect(f.calls).toEqual([]);
});
it('does not connect out-of-profile peers, returns no matching metadata, and refuses guessed handles', async () => {
  const state = profileState(['native', 'native']);
  state.profiles[0]!.connectorIds = ['connector-0'];
  state.agentProfileBindings = { cursor: 'profile' };
  const f = await setup({
    state,
    tools: {
      'connector-0': [tool('read')],
      'connector-1': [
        tool('private_name', 'PRIVATE OUTSIDE DESCRIPTION', {
          _meta: { keywords: ['outside'] },
        }),
      ],
    },
  });
  expect((await f.search('outside')).tools).toEqual([]);
  expect(await f.call('connector-1__private_name')).toMatchObject({
    content: [{ text: 'tool_scope_denied' }],
  });
  expect(f.starts).toEqual(['connector-0']);
  expect(f.calls).toEqual([]);
});
it('denies cached handles after reassignment, even after a new scoped search', async () => {
  const f = await setup();
  await f.search('read');
  f.state.profiles[0]!.connectorIds = ['connector-0'];
  f.state.agentProfileBindings = { cursor: 'profile' };
  f.state.revision++;
  await f.search('read');
  expect(await f.call('connector-1__read')).toMatchObject({
    content: [{ text: 'tool_scope_denied' }],
  });
  expect(f.calls).toEqual([]);
});
it('requires fresh Ask confirmation for each meta-call and forwards the exact nested arguments', async () => {
  const state = profileState(['native']);
  state.connectors[0]!.toolPolicies = { write: 'ask' };
  const f = await setup({
    state,
    confirm: async () => ({ action: 'accept', content: { approve: true } }),
  });
  await f.search('write');
  for (const value of ['first', 'second'])
    expect(await f.call('connector-0__write', { value })).toMatchObject({
      content: [{ text: 'synthetic success' }],
    });
  expect(f.prompts).toHaveLength(2);
  expect(f.calls.map((call) => call.arguments)).toEqual([
    { value: 'first' },
    { value: 'second' },
  ]);
  expect(f.prompts[0]).toMatchObject({
    params: { message: expect.stringContaining('"value":"first"') },
  });
});
it.each(['unsupported', 'decline'] as const)(
  'fails closed for %s Ask confirmation',
  async (mode) => {
    const state = profileState(['native']);
    state.connectors[0]!.toolPolicies = { read: 'ask' };
    const f = await setup({
      state,
      ...(mode === 'decline'
        ? { confirm: async () => ({ action: 'decline' as const }) }
        : {}),
    });
    await f.search('read');
    expect(await f.call('connector-0__read')).toHaveProperty('isError', true);
    expect(f.calls).toEqual([]);
  },
);
it('refuses a pending meta-call after search mode changes during confirmation', async () => {
  const state = profileState(['native']);
  state.connectors[0]!.toolPolicies = { read: 'ask' };
  let resolve!: (value: ElicitResult) => void, started!: () => void;
  const prompt = new Promise<void>((r) => {
      started = r;
    }),
    f = await setup({
      state,
      confirm: async () => {
        started();
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
  await f.search('read');
  const call = f.call('connector-0__read');
  await prompt;
  state.agentToolSearchModes = {};
  state.revision++;
  resolve({ action: 'accept', content: { approve: true } });
  expect(await call).toMatchObject({
    content: [{ text: 'tool_search_mode_changed' }],
  });
  expect(f.calls).toEqual([]);
});
it('rechecks Block during discovery and never returns now-blocked schemas', async () => {
  const state = profileState(['native']);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    pending = new Promise<void>((r) => {
      started = r;
    }),
    f = await setup({ state, listGate: gate, listed: started }),
    search = f.search('read');
  await pending;
  state.connectors[0]!.toolPolicies = { read: 'block' };
  state.revision++;
  release();
  expect((await search).tools).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('rejects recursive meta invocations and obsolete direct calls while search mode is enabled', async () => {
  const f = await setup();
  for (const name of ['search_tools', 'call_tool'])
    expect(await f.call(name)).toMatchObject({
      content: [{ text: 'tool_search_recursion_denied' }],
    });
  expect(await f.agent.callTool({ name: 'connector-0__read' })).toMatchObject({
    content: [{ text: 'tool_search_required' }],
  });
  expect(f.starts).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('does not forward a formerly discovered tool removed from a fresh catalog', async () => {
  const tools = { 'connector-0': [tool('read')], 'connector-1': [] },
    f = await setup({ tools });
  await f.search('read');
  tools['connector-0'] = [];
  await f.search('read');
  expect(await f.call('connector-0__read')).toMatchObject({
    content: [{ text: 'tool_not_found' }],
  });
  expect(f.calls).toEqual([]);
});
it('preserves credential echo protection for both search metadata and call results', async () => {
  const secret = 'SYNTHETIC-SEARCH-CREDENTIAL-PRIVATE',
    metadata = await setup({
      secret,
      tools: { 'connector-0': [tool('read', secret)], 'connector-1': [] },
    });
  expect(JSON.stringify(await metadata.search('read'))).not.toContain(secret);
  const call = await setup({ secret, echo: true });
  await call.search('read');
  const result = await call.call('connector-0__read');
  expect(result).toHaveProperty('isError', true);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(call.calls).toHaveLength(1);
});
it('bounds search result bytes instead of returning oversized schemas', async () => {
  const f = await setup({
      tools: {
        'connector-0': [
          tool('huge', 'Huge schema', {
            inputSchema: {
              type: 'object',
              description: 'x'.repeat(300 * 1024),
            },
          }),
        ],
        'connector-1': [],
      },
    }),
    result = await f.search('huge');
  expect(result.tools).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(result.hasMore).toBe(true);
});
it.each([
  { query: 'x'.repeat(257) },
  { query: 'x', limit: 0 },
  { query: 'x', limit: 51 },
  { query: 'x', limit: 1.5 },
  { query: 'x', limit: '10' },
  { query: 'x', extra: true },
])('rejects malformed search arguments %j', (input) =>
  expect(SearchToolsArgumentsSchema.safeParse(input).success).toBe(false),
);
it('validates meta-call arguments and rejects dangerous raw record keys instead of dropping them', () => {
  expect(SearchToolsArgumentsSchema.parse({ query: '' }).limit).toBe(10);
  expect(
    CallToolArgumentsSchema.safeParse({
      name: 'connector__read',
      arguments: { value: 1 },
    }).success,
  ).toBe(true);
  for (const input of [
    { name: '' },
    { name: 'x', extra: 1 },
    { name: 'x', arguments: [] },
    { name: 'x', arguments: JSON.parse('{"__proto__":"private"}') },
  ])
    expect(CallToolArgumentsSchema.safeParse(input).success).toBe(false);
});
it.each(['unknown', 'constructor', 'prototype', '__proto__'])(
  'rejects invalid search setting key %s',
  (key) =>
    expect(
      AgentToolSearchModesSchema.safeParse(JSON.parse(`{"${key}":true}`))
        .success,
    ).toBe(false),
);
it('journals per-agent mode settings with CAS without changing approvals, profile assignments or observations', async () => {
  const state = profileState(['native']),
    store = memoryStore(state),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety);
  cleanup.push(() => hub.close());
  const input = {
      kind: 'set_agent_tool_search',
      agentId: 'cursor',
      toolSearchMode: true,
      expectedRevision: 0,
    },
    first = await hub.preview(input, 'owner'),
    second = await hub.preview({ ...input, agentId: 'codex' }, 'owner');
  expect(first.affectedAgents).toContain('cursor');
  const job = await hub.apply(first.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('succeeded');
  await expect(hub.apply(second.id, 'owner')).rejects.toHaveProperty(
    'code',
    'conflict',
  );
  const saved = await hub.inventory();
  expect(saved.agentToolSearchModes).toEqual({ cursor: true });
  expect(saved.agentProfileBindings).toBeUndefined();
  expect(saved.profiles).toEqual(state.profiles);
  expect(approved(saved.connectors[0]!)).toBe(true);
  expect((await safety.read()).operations.at(-1)).toMatchObject({
    operation: 'set_agent_tool_search',
    phase: 'committed',
  });
  await apply(hub, {
    kind: 'set_agent_profile',
    agentId: 'cursor',
    profileId: 'profile',
  });
  expect((await hub.inventory()).agentToolSearchModes).toEqual({
    cursor: true,
  });
  await apply(hub, {
    kind: 'set_agent_tool_search',
    agentId: 'cursor',
    toolSearchMode: false,
  });
  expect((await hub.inventory()).agentToolSearchModes).toEqual({});
});
it('bounds catalog growth and explicitly reports incomplete searches', async () => {
  const f = await setup({
      tools: {
        'connector-0': Array.from({ length: 4200 }, (_, index) =>
          tool(`item_${String(index).padStart(4, '0')}`),
        ),
        'connector-1': [],
      },
    }),
    result = await f.search('item', 1);
  expect(result.tools).toHaveLength(1);
  expect(result.hasMore).toBe(true);
  expect(result.truncated).toBe(true);
  expect(f.calls).toEqual([]);
});
it('exposes only the meta pair for an empty assigned profile but discovers nothing', async () => {
  const state = profileState(['native']);
  state.agentProfileBindings = { cursor: 'profile' };
  state.profiles[0]!.enabled = false;
  const f = await setup({ state });
  expect((await f.agent.listTools()).tools).toHaveLength(2);
  expect((await f.search('')).tools).toEqual([]);
  expect(f.starts).toEqual([]);
  expect(await f.call('connector-0__read')).toHaveProperty('isError', true);
  expect(f.calls).toEqual([]);
});
it('rechecks profile boundaries after discovery I/O before returning any schemas', async () => {
  const state = profileState(['native']);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    pending = new Promise<void>((r) => {
      started = r;
    }),
    f = await setup({ state, listGate: gate, listed: started }),
    result = f.search('read');
  await pending;
  state.agentProfileBindings = { cursor: 'profile' };
  state.profiles[0]!.connectorIds = [];
  state.revision++;
  release();
  expect((await result).tools).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('returns safe argument errors at the MCP boundary without discovery or value echoes', async () => {
  const f = await setup(),
    privateValue = 'SYNTHETIC-INVALID-SEARCH-PRIVATE';
  for (const request of [
    { name: 'search_tools', arguments: { query: privateValue.repeat(20) } },
    {
      name: 'call_tool',
      arguments: { name: 'connector-0__read', arguments: [] },
    },
  ]) {
    const result = await f.agent.callTool(request);
    expect(result).toMatchObject({
      content: [{ text: 'tool_search_invalid_arguments' }],
    });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  }
  expect(f.starts).toEqual([]);
});
it('does not persist a search-mode change when the journaled registry commit fails', async () => {
  const store = memoryStore(profileState(['native'])),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety);
  cleanup.push(() => hub.close());
  store.write = async () => {
    throw new Error('Synthetic storage failure');
  };
  const preview = await hub.preview(
      {
        kind: 'set_agent_tool_search',
        agentId: 'cursor',
        toolSearchMode: true,
        expectedRevision: 0,
      },
      'owner',
    ),
    job = await hub.apply(preview.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('failed');
  expect((await store.read()).agentToolSearchModes).toBeUndefined();
  expect((await safety.read()).operations.at(-1)?.phase).toBe('aborted');
});
