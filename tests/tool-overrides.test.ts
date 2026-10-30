import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it } from 'vitest';
import {
  createAgentBridge,
  createLifecycle,
  createMemorySafetyLedger,
  approved,
  definitionHash,
} from '@waleed/hub-core';
import {
  ToolOverrideSchema,
  ToolOverridesCollectionSchema,
  SearchToolsResultSchema,
  StateSchema,
} from '@waleed/contracts';
import { playgroundFixture } from './helpers/playground.js';
import { memoryStore } from './helpers/memory-store.js';
import { profileState, apply } from './helpers/runtime.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  options: Parameters<typeof playgroundFixture>[0] = {},
  confirm?: () => Promise<ElicitResult>,
) {
  const f = playgroundFixture(options),
    bridge = createAgentBridge(
      async () => structuredClone(f.state),
      f.connect,
      'cursor',
    ),
    [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'synthetic-overrides', version: '1' },
    { capabilities: confirm ? { elicitation: { form: {} } } : {} },
  );
  if (confirm)
    agent.setRequestHandler(ElicitRequestSchema, async () => confirm());
  await agent.connect(b);
  cleanup.push(async () => {
    await agent.close();
    await bridge.close();
    await f.playground.close();
  });
  const override = (extra: Record<string, unknown> = {}) => {
    f.state.toolOverrides = [
      ToolOverrideSchema.parse({
        connectorId: 'connector-0',
        originalToolName: 'read',
        alias: 'inspect_records',
        customDescription: 'Find invoices for the selected month.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        ...extra,
      }),
    ];
  };
  return { ...f, bridge, agent, override };
}
it('transforms only agent metadata and dispatches aliases, canonical handles and unambiguous original names to the same tool', async () => {
  const f = await setup();
  f.setTools([
    {
      name: 'read',
      description: 'Provider description',
      inputSchema: { type: 'object' },
      annotations: { openWorldHint: false, destructiveHint: true },
    },
  ]);
  f.override();
  const result = await f.agent.listTools();
  expect(result.tools).toEqual([
    {
      name: 'inspect_records',
      description: 'Find invoices for the selected month.',
      inputSchema: { type: 'object' },
      annotations: {
        openWorldHint: false,
        destructiveHint: false,
        readOnlyHint: true,
      },
    },
  ]);
  for (const name of ['inspect_records', 'connector-0__read', 'read'])
    expect(
      await f.agent.callTool({
        name,
        arguments: { value: 'SYNTHETIC-ARG-PRIVATE' },
      }),
    ).not.toHaveProperty('isError', true);
  expect(f.calls).toEqual(
    Array.from({ length: 3 }, () => ({
      name: 'read',
      arguments: { value: 'SYNTHETIC-ARG-PRIVATE' },
    })),
  );
  expect(
    f.bridge.requestLog.records().every((record) => record.toolName === 'read'),
  ).toBe(true);
  expect(JSON.stringify(f.bridge.requestLog.records())).not.toContain(
    'inspect_records',
  );
  expect(approved(f.state.connectors[0]!)).toBe(true);
});
it('preserves default generated names and metadata when overrides are absent', async () => {
  const f = await setup();
  expect((await f.agent.listTools()).tools[0]).toMatchObject({
    name: 'connector-0__read',
    description: 'connector-0: Read synthetic data',
  });
  expect(StateSchema.parse(f.state)).not.toHaveProperty('toolOverrides');
});
it('supports a 64-character alias and a full 2,000-character description in normal and search catalogs', async () => {
  const f = await setup(),
    alias = 'a'.repeat(64),
    description = 'd'.repeat(2000);
  f.override({ alias, customDescription: description });
  expect((await f.agent.listTools()).tools[0]).toMatchObject({
    name: alias,
    description,
  });
  f.state.agentToolSearchModes = { cursor: true };
  const result = await f.agent.callTool({
    name: 'search_tools',
    arguments: { query: alias },
  });
  expect(
    SearchToolsResultSchema.parse(result.structuredContent).tools[0],
  ).toMatchObject({ name: alias, description });
});
it('finds overridden tools by alias, original name and custom description and invokes the exact original', async () => {
  const f = await setup();
  f.override();
  f.state.agentToolSearchModes = { cursor: true };
  expect((await f.agent.listTools()).tools.map((tool) => tool.name)).toEqual([
    'search_tools',
    'call_tool',
  ]);
  for (const query of ['inspect_records', 'read', 'invoices month']) {
    const result = await f.agent.callTool({
      name: 'search_tools',
      arguments: { query },
    });
    expect(
      SearchToolsResultSchema.parse(result.structuredContent).tools[0]?.name,
    ).toBe('inspect_records');
  }
  expect(
    await f.agent.callTool({
      name: 'call_tool',
      arguments: { name: 'inspect_records', arguments: { value: 'literal' } },
    }),
  ).not.toHaveProperty('isError', true);
  expect(f.calls).toEqual([{ name: 'read', arguments: { value: 'literal' } }]);
});
it.each(['inspect_records', 'connector-0__read', 'read'])(
  'enforces Block on %s despite read-only annotations',
  async (name) => {
    const f = await setup();
    f.override();
    f.state.connectors[0]!.toolPolicies = { read: 'block' };
    expect((await f.agent.listTools()).tools).toEqual([]);
    expect(await f.agent.callTool({ name })).toMatchObject({
      isError: true,
      content: [{ text: 'tool_blocked' }],
    });
    expect(f.calls).toEqual([]);
  },
);
it('requires fresh Ask approval for each alias/canonical call, and fails closed for declined approval', async () => {
  let accepted = true,
    prompts = 0;
  const f = await setup({}, async () => {
    prompts++;
    return accepted
      ? { action: 'accept', content: { approve: true } }
      : { action: 'decline' };
  });
  f.override();
  f.state.connectors[0]!.toolPolicies = { read: 'ask' };
  await f.agent.listTools();
  for (const name of ['inspect_records', 'connector-0__read'])
    expect(await f.agent.callTool({ name })).not.toHaveProperty(
      'isError',
      true,
    );
  accepted = false;
  expect(await f.agent.callTool({ name: 'inspect_records' })).toMatchObject({
    content: [{ text: 'tool_approval_denied' }],
  });
  expect(prompts).toBe(3);
  expect(f.calls).toHaveLength(2);
});
it('fails closed for aliases outside a new agent assignment and never publishes their descriptions', async () => {
  const f = await setup();
  f.override();
  await f.agent.listTools();
  f.state.agentProfileBindings = { cursor: 'profile' };
  f.state.profiles[0]!.connectorIds = [];
  expect(await f.agent.callTool({ name: 'inspect_records' })).toMatchObject({
    content: [{ text: 'tool_scope_denied' }],
  });
  expect((await f.agent.listTools()).tools).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('invalidates obsolete aliases immediately, including after reset, without restarting the managed peer', async () => {
  const f = await setup();
  f.override();
  await f.agent.listTools();
  const starts = f.peers.started;
  f.override({ alias: 'browse_records' });
  expect(await f.agent.callTool({ name: 'inspect_records' })).toMatchObject({
    content: [{ text: 'tool_override_stale' }],
  });
  expect((await f.agent.listTools()).tools[0]!.name).toBe('browse_records');
  expect(await f.agent.callTool({ name: 'browse_records' })).not.toHaveProperty(
    'isError',
    true,
  );
  f.state.toolOverrides = [];
  expect(await f.agent.callTool({ name: 'browse_records' })).toMatchObject({
    content: [{ text: 'tool_override_stale' }],
  });
  expect((await f.agent.listTools()).tools[0]!.name).toBe('connector-0__read');
  expect(f.peers.started).toBe(starts);
});
it('does not retarget a retired alias to another tool within the same live bridge', async () => {
  const f = await setup();
  f.setTools([
    { name: 'read', inputSchema: { type: 'object' } },
    { name: 'write', inputSchema: { type: 'object' } },
  ]);
  f.override();
  await f.agent.listTools();
  f.state.toolOverrides = [
    {
      connectorId: 'connector-0',
      originalToolName: 'write',
      alias: 'inspect_records',
    },
  ];
  const result = await f.agent.listTools();
  expect(result.tools.some((tool) => tool.name === 'inspect_records')).toBe(
    false,
  );
  expect(await f.agent.callTool({ name: 'inspect_records' })).toMatchObject({
    content: [{ text: 'tool_alias_conflict' }],
  });
  expect(f.calls).toEqual([]);
});
it('refuses a newly introduced alias collision even before discovery can refresh its routing map', async () => {
  const f = await setup();
  f.setTools([
    { name: 'read', inputSchema: { type: 'object' } },
    { name: 'write', inputSchema: { type: 'object' } },
  ]);
  await f.agent.listTools();
  f.override({ alias: 'connector-0__write' });
  expect(await f.agent.callTool({ name: 'connector-0__write' })).toMatchObject({
    content: [{ text: 'tool_alias_conflict' }],
  });
  const result = await f.agent.listTools();
  expect(result.tools.some((tool) => tool.name === 'connector-0__write')).toBe(
    false,
  );
  expect(f.calls).toEqual([]);
});
it('refuses aliases that collide with newly discovered original names instead of silently retargeting', async () => {
  const f = await setup();
  f.override({ alias: 'write' });
  f.setTools([
    { name: 'read', inputSchema: { type: 'object' } },
    { name: 'write', inputSchema: { type: 'object' } },
  ]);
  const result = await f.agent.listTools();
  expect(result.tools.map((tool) => tool.name)).toEqual(['connector-0__write']);
  expect(await f.agent.callTool({ name: 'write' })).toMatchObject({
    content: [{ text: 'tool_alias_conflict' }],
  });
  expect(f.calls).toEqual([]);
});
it('rechecks changed metadata after discovery I/O before exposing an override', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    f = await setup({ listGate: gate });
  f.override();
  const listing = f.agent.listTools();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  f.override({ customDescription: 'new review required' });
  release();
  expect((await listing).tools).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('rechecks metadata during Ask confirmation and never dispatches stale consent', async () => {
  let answer!: (value: ElicitResult) => void, ready!: () => void;
  const prompt = new Promise<void>((resolve) => {
      ready = resolve;
    }),
    f = await setup({}, async () => {
      ready();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
  f.override();
  f.state.connectors[0]!.toolPolicies = { read: 'ask' };
  await f.agent.listTools();
  const call = f.agent.callTool({ name: 'inspect_records' });
  await prompt;
  f.override({ annotations: { readOnlyHint: false } });
  answer({ action: 'accept', content: { approve: true } });
  expect(await call).toMatchObject({
    content: [{ text: 'tool_override_stale' }],
  });
  expect(f.calls).toEqual([]);
});
it('withholds an in-flight result if its override review changes', async () => {
  let release!: () => void, called!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      called = resolve;
    }),
    f = await setup({ callGate: gate, onCall: called });
  f.override();
  await f.agent.listTools();
  const call = f.agent.callTool({ name: 'inspect_records' });
  await ready;
  f.override({ alias: 'renamed_again' });
  release();
  expect(await call).toMatchObject({
    content: [{ text: 'tool_override_stale' }],
  });
  expect(f.calls).toHaveLength(1);
});
it('preserves known-credential echo protection for transformed descriptions', async () => {
  const secret = 'SYNTHETIC-PROTECTED-OVERRIDE-CREDENTIAL',
    f = await setup({ secret });
  f.override({ customDescription: secret });
  expect(JSON.stringify(await f.agent.listTools())).not.toContain(secret);
  expect((await f.agent.listTools()).tools).toEqual([]);
});
it.each([
  'search_tools',
  'call_tool',
  'SEARCH_TOOLS',
  'constructor',
  '__proto__',
  'bad name',
  'a'.repeat(65),
])('rejects unsafe/reserved alias %s', (alias) =>
  expect(
    ToolOverrideSchema.safeParse({
      connectorId: 'connector',
      originalToolName: 'read',
      alias,
    }).success,
  ).toBe(false),
);
it('bounds and validates inert annotations, rejects prototype keys and accepts supported false hints', () => {
  const base = { connectorId: 'connector', originalToolName: 'read' };
  expect(
    ToolOverrideSchema.parse({
      ...base,
      annotations: {
        readOnlyHint: false,
        custom: { values: [1, 'two', null] },
      },
    }).annotations,
  ).toHaveProperty('readOnlyHint', false);
  for (const annotations of [
    JSON.parse('{"__proto__":{"private":"value"}}'),
    { nested: JSON.parse('{"constructor":"value"}') },
    { readOnlyHint: 'true' },
    { title: 7 },
    { blob: 'x'.repeat(8193) },
    { callback: () => 1 },
  ])
    expect(ToolOverrideSchema.safeParse({ ...base, annotations }).success).toBe(
      false,
    );
  expect(
    ToolOverridesCollectionSchema.safeParse([
      { ...base, alias: 'same' },
      { ...base, originalToolName: 'write', alias: 'same' },
    ]).success,
  ).toBe(false);
  expect(
    ToolOverrideSchema.safeParse({
      ...base,
      customDescription: 'x'.repeat(2001),
    }).success,
  ).toBe(false);
});
it('journals revision-safe metadata changes without altering approval, execution definition or discovered observations', async () => {
  const state = profileState(['native']),
    store = memoryStore(state),
    hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      runtime: {
        async discover() {
          return {
            tools: [{ name: 'read', role: 'upstream' }],
            resourceCount: 0,
            promptCount: 0,
            protocolVersion: 'synthetic',
          };
        },
      },
    });
  cleanup.push(() => hub.close());
  const check = await hub.checks.start('connector-0', 'owner');
  await hub.checks.wait(check.id, 'owner');
  const before = await hub.checks.observations(),
    override = {
      connectorId: 'connector-0',
      originalToolName: 'read',
      alias: 'inspect_records',
    };
  const first = await hub.preview(
      {
        kind: 'set_tool_override',
        connectorId: 'connector-0',
        originalToolName: 'read',
        override,
        expectedRevision: 0,
        expectedConnectorRevision: 1,
      },
      'owner',
    ),
    stale = await hub.preview(
      {
        kind: 'set_tool_override',
        connectorId: 'connector-0',
        originalToolName: 'read',
        override: { ...override, alias: 'different' },
        expectedRevision: 0,
        expectedConnectorRevision: 1,
      },
      'other',
    );
  const job = await hub.apply(first.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('succeeded');
  await expect(hub.apply(stale.id, 'other')).rejects.toHaveProperty(
    'code',
    'conflict',
  );
  const saved = await hub.inventory();
  expect(saved.toolOverrides).toEqual([override]);
  expect(approved(saved.connectors[0]!)).toBe(true);
  expect(definitionHash(saved.connectors[0]!)).toBe(
    definitionHash(state.connectors[0]!),
  );
  expect(await hub.checks.observations()).toEqual(before);
  expect(JSON.stringify((await hub.safety.read()).operations)).not.toContain(
    'inspect_records',
  );
  await apply(hub, {
    kind: 'set_tool_override',
    connectorId: 'connector-0',
    originalToolName: 'read',
    override: null,
    expectedConnectorRevision: 1,
  });
  expect((await hub.inventory()).toolOverrides).toEqual([]);
});
it('does not let a disabled connector alias shadow an eligible tool, and fails closed once both are exposed', async () => {
  const f = await setup();
  Object.assign(f.state, profileState(['native', 'native']));
  f.state.connectors[1]!.enabled = false;
  f.state.toolOverrides = [
    {
      connectorId: 'connector-1',
      originalToolName: 'read',
      alias: 'connector-0__read',
    },
  ];
  expect((await f.agent.listTools()).tools.map((tool) => tool.name)).toEqual([
    'connector-0__read',
  ]);
  expect(
    await f.agent.callTool({ name: 'connector-0__read' }),
  ).not.toHaveProperty('isError', true);
  f.state.connectors[1]!.enabled = true;
  expect(
    (await f.agent.listTools()).tools.map((tool) => tool.name),
  ).not.toContain('connector-0__read');
  expect(await f.agent.callTool({ name: 'connector-0__read' })).toMatchObject({
    content: [{ text: 'tool_alias_conflict' }],
  });
  expect(f.calls).toHaveLength(1);
});
it('does not commit override metadata when storage fails, and removes orphan overrides with a connector', async () => {
  const state = profileState(['native']),
    store = memoryStore(state),
    hub = createLifecycle(store, Date.now, createMemorySafetyLedger());
  cleanup.push(() => hub.close());
  const input = {
      kind: 'set_tool_override',
      connectorId: 'connector-0',
      originalToolName: 'read',
      override: {
        connectorId: 'connector-0',
        originalToolName: 'read',
        alias: 'inspect_records',
      },
      expectedRevision: 0,
      expectedConnectorRevision: 1,
    },
    preview = await hub.preview(input, 'owner'),
    write = store.write;
  store.write = async () => {
    throw new Error('Synthetic failure');
  };
  const job = await hub.apply(preview.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('failed');
  expect((await store.read()).toolOverrides).toBeUndefined();
  store.write = write;
  await apply(hub, input);
  await apply(hub, { kind: 'remove_connector', connectorId: 'connector-0' });
  expect((await hub.inventory()).toolOverrides).toEqual([]);
});
it('refuses override metadata while a direct profile snapshot still exposes the connector', async () => {
  const state = profileState(['native']);
  state.materializations = [
    {
      profileId: 'profile',
      profileRevision: 1,
      configurationHash: '0'.repeat(64),
      files: [],
      dockerProfileId: null,
      dockerHash: null,
      appliedAt: new Date().toISOString(),
    },
  ];
  const hub = createLifecycle(memoryStore(state));
  cleanup.push(() => hub.close());
  await expect(
    hub.preview(
      {
        kind: 'set_tool_override',
        connectorId: 'connector-0',
        originalToolName: 'read',
        expectedRevision: 0,
        expectedConnectorRevision: 1,
        override: {
          connectorId: 'connector-0',
          originalToolName: 'read',
          alias: 'inspect_records',
        },
      },
      'owner',
    ),
  ).rejects.toHaveProperty('code', 'conflict');
});
