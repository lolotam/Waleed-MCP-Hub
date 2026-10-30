import { afterEach, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ConnectorSchema,
  ToolPoliciesSchema,
  type ToolPolicy,
} from '@waleed/contracts';
import {
  createAgentBridge,
  createLifecycle,
  createMemorySafetyLedger,
  definitionHash,
  approved,
} from '@waleed/hub-core';
import { profileState, apply, definition } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
import { managedFixture } from './helpers/materialization.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  policies?: Record<string, ToolPolicy>,
  confirm?: (request: unknown) => Promise<ElicitResult>,
  discoveryGate?: Promise<void>,
  discoveryStarted?: () => void,
  onCall?: (name: string) => Promise<void>,
) {
  const state = profileState(['native']);
  if (policies) state.connectors[0]!.toolPolicies = policies;
  const calls: Array<{ name: string; arguments: unknown }> = [],
    prompts: unknown[] = [];
  let starts = 0;
  const bridge = createAgentBridge(
    async () => structuredClone(state),
    async () => {
      starts++;
      const upstream = new Server(
        { name: 'synthetic-policy-peer', version: '1' },
        { capabilities: { tools: {} } },
      );
      upstream.setRequestHandler(ListToolsRequestSchema, async () => {
        discoveryStarted?.();
        await discoveryGate;
        return {
          tools: [
            {
              name: 'read',
              inputSchema: { type: 'object' as const },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'write',
              description: 'SYNTHETIC HIDDEN DESCRIPTION',
              inputSchema: { type: 'object' as const },
            },
            { name: 'delete', inputSchema: { type: 'object' as const } },
          ],
        };
      });
      upstream.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push({
          name: request.params.name,
          arguments: request.params.arguments,
        });
        await onCall?.(request.params.name);
        return {
          content: [{ type: 'text' as const, text: 'synthetic success' }],
        };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await upstream.connect(a);
      const client = new Client(
        { name: 'synthetic-policy-hub', version: '1' },
        { capabilities: {} },
      );
      await client.connect(b);
      return {
        client,
        assertPublic() {},
        async dispose() {
          await client.close();
          await upstream.close();
        },
      };
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'synthetic-policy-agent', version: '1' },
    { capabilities: confirm ? { elicitation: { form: {} } } : {} },
  );
  if (confirm)
    agent.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request);
      return confirm(request);
    });
  await agent.connect(b);
  cleanup.push(async () => {
    await agent.close();
    await bridge.close();
  });
  return { agent, bridge, state, calls, prompts, starts: () => starts };
}
it('keeps legacy connectors unchanged and defaults read-only and other unconfigured tools to Allow', async () => {
  const f = await setup();
  expect(ConnectorSchema.parse(f.state.connectors[0])).not.toHaveProperty(
    'toolPolicies',
  );
  expect((await f.agent.listTools()).tools).toHaveLength(3);
  await f.agent.callTool({ name: 'connector-0__read' });
  await f.agent.callTool({ name: 'connector-0__write' });
  expect(f.calls.map((call) => call.name)).toEqual(['read', 'write']);
  expect(f.prompts).toEqual([]);
});
it('omits blocked names, descriptions and schemas entirely but refuses guessed calls with tool_blocked', async () => {
  const f = await setup({ write: 'block' }),
    catalog = await f.agent.listTools();
  expect(catalog.tools.map((tool) => tool.name)).toEqual([
    'connector-0__read',
    'connector-0__delete',
  ]);
  expect(JSON.stringify(catalog)).not.toContain('SYNTHETIC HIDDEN DESCRIPTION');
  expect(await f.agent.callTool({ name: 'connector-0__write' })).toMatchObject({
    isError: true,
    structuredContent: { error: 'tool_blocked' },
    content: [{ text: 'tool_blocked' }],
  });
  expect(f.calls).toEqual([]);
});
it('blocks previously advertised handles without requiring a list refresh or another peer connection', async () => {
  const f = await setup();
  await f.agent.listTools();
  f.state.connectors[0]!.toolPolicies = { read: 'block' };
  f.state.revision++;
  expect(await f.agent.callTool({ name: 'connector-0__read' })).toMatchObject({
    isError: true,
    content: [{ text: 'tool_blocked' }],
  });
  expect(f.calls).toEqual([]);
  expect(f.starts()).toBe(1);
});
it('requires an elicitation-capable agent for Ask and never silently allows a readOnlyHint', async () => {
  const f = await setup({ read: 'ask' });
  await f.agent.listTools();
  expect(await f.agent.callTool({ name: 'connector-0__read' })).toMatchObject({
    isError: true,
    content: [{ text: 'tool_approval_required' }],
  });
  expect(f.calls).toEqual([]);
});
it('confirms each Ask invocation independently and forwards exactly the reviewed arguments once', async () => {
  const f = await setup({ write: 'ask' }, async () => ({
    action: 'accept',
    content: { approve: true },
  }));
  await f.agent.listTools();
  for (const count of [1, 2])
    expect(
      await f.agent.callTool({
        name: 'connector-0__write',
        arguments: { count },
      }),
    ).toMatchObject({ content: [{ text: 'synthetic success' }] });
  expect(f.calls).toEqual([
    { name: 'write', arguments: { count: 1 } },
    { name: 'write', arguments: { count: 2 } },
  ]);
  expect(f.prompts).toHaveLength(2);
  expect(f.prompts[0]).toMatchObject({
    params: { message: expect.stringContaining('"count":1') },
  });
});
it.each([
  { action: 'decline' },
  { action: 'cancel' },
  { action: 'accept', content: { approve: false } },
  { action: 'accept', content: {} },
] satisfies ElicitResult[])(
  'refuses Ask response %j without calling a tool',
  async (response) => {
    const f = await setup({ write: 'ask' }, async () => response);
    await f.agent.listTools();
    expect(
      await f.agent.callTool({ name: 'connector-0__write' }),
    ).toHaveProperty('isError', true);
    expect(f.calls).toEqual([]);
  },
);
it('fails closed on elicitation errors without reflecting diagnostics', async () => {
  const f = await setup({ write: 'ask' }, async () => {
    throw new Error('SYNTHETIC_PRIVATE_CONFIRMATION_FAILURE');
  });
  await f.agent.listTools();
  const result = await f.agent.callTool({ name: 'connector-0__write' });
  expect(result).toHaveProperty('isError', true);
  expect(JSON.stringify(result)).not.toContain(
    'SYNTHETIC_PRIVATE_CONFIRMATION_FAILURE',
  );
  expect(f.calls).toEqual([]);
});
it.each(['block', 'allow', 'ask'] as const)(
  'invalidates pending confirmation after inventory policy change to %s',
  async (policy) => {
    let answer!: (value: ElicitResult) => void, started!: () => void;
    const prompt = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await setup({ write: 'ask' }, async () => {
      started();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    await f.agent.listTools();
    const call = f.agent.callTool({
      name: 'connector-0__write',
      arguments: { action: 'synthetic' },
    });
    await prompt;
    f.state.connectors[0]!.toolPolicies = { write: policy };
    f.state.revision++;
    answer({ action: 'accept', content: { approve: true } });
    expect(await call).toMatchObject({
      isError: true,
      content: [
        { text: policy === 'block' ? 'tool_blocked' : 'tool_approval_stale' },
      ],
    });
    expect(f.calls).toEqual([]);
  },
);
it('does not execute an Ask call after cancellation even if a late approval arrives', async () => {
  let answer!: (value: ElicitResult) => void, started!: () => void;
  const prompt = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await setup({ write: 'ask' }, async () => {
    started();
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  await f.agent.listTools();
  const controller = new AbortController(),
    call = f.agent.callTool({ name: 'connector-0__write' }, undefined, {
      signal: controller.signal,
    });
  await prompt;
  controller.abort();
  await expect(call).rejects.toThrow();
  answer({ action: 'accept', content: { approve: true } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.calls).toEqual([]);
});
it('refuses oversized Ask arguments instead of asking about a truncated call', async () => {
  const f = await setup({ write: 'ask' }, async () => ({
    action: 'accept',
    content: { approve: true },
  }));
  await f.agent.listTools();
  expect(
    await f.agent.callTool({
      name: 'connector-0__write',
      arguments: { value: 'x'.repeat(17 * 1024) },
    }),
  ).toHaveProperty('isError', true);
  expect(f.prompts).toEqual([]);
  expect(f.calls).toEqual([]);
});
it.each([
  'constructor',
  'prototype',
  '__proto__',
  'a.b',
  'a/b',
  'x'.repeat(65),
  '',
])('rejects unsafe tool-policy key %j', (key) => {
  expect(
    ToolPoliciesSchema.safeParse(JSON.parse(JSON.stringify({ [key]: 'block' })))
      .success,
  ).toBe(false);
});
it('bounds policy count and values', () => {
  expect(
    ToolPoliciesSchema.safeParse(
      Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`tool_${index}`, 'block']),
      ),
    ).success,
  ).toBe(false);
  expect(ToolPoliciesSchema.safeParse({ read: 'unknown' }).success).toBe(false);
});
it('journals policy updates with CAS while preserving execution approval and policies on ordinary edit', async () => {
  const state = profileState(['native']),
    store = memoryStore(state),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety);
  cleanup.push(() => hub.close());
  const hash = definitionHash(state.connectors[0]!);
  const input = {
    kind: 'set_tool_policies',
    expectedRevision: 0,
    expectedConnectorRevision: 1,
    connectorId: 'connector-0',
    toolPolicies: { read: 'block' },
  };
  const first = await hub.preview(input, 'owner'),
    second = await hub.preview(input, 'owner');
  const job = await hub.apply(first.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('succeeded');
  await expect(hub.apply(second.id, 'owner')).rejects.toHaveProperty(
    'code',
    'conflict',
  );
  const saved = (await store.read()).connectors[0]!;
  expect(saved.toolPolicies).toEqual({ read: 'block' });
  expect(saved.revision).toBe(1);
  expect(definitionHash(saved)).toBe(hash);
  expect(approved(saved)).toBe(true);
  expect((await safety.read()).operations.at(-1)).toMatchObject({
    operation: 'set_tool_policies',
    phase: 'committed',
  });
  const edited = await apply(hub, {
    kind: 'edit_connector',
    connectorId: saved.id,
    definition: definition({
      id: saved.id,
      name: saved.name,
      command: 'C:\\Synthetic Space\\node.exe',
      args: ['changed.mjs'],
    }),
  });
  expect(edited.state).toBe('succeeded');
  expect((await store.read()).connectors[0]!.toolPolicies).toEqual({
    read: 'block',
  });
});
it('rejects stale connector revisions and restricting an existing direct materialization', async () => {
  const state = profileState(['native']),
    fixture = managedFixture(),
    hub = createLifecycle(
      memoryStore(state),
      Date.now,
      createMemorySafetyLedger(),
      { materializer: fixture.materializer },
    );
  cleanup.push(() => hub.close());
  await expect(
    hub.preview(
      {
        kind: 'set_tool_policies',
        expectedRevision: 0,
        expectedConnectorRevision: 99,
        connectorId: 'connector-0',
        toolPolicies: { read: 'block' },
      },
      'owner',
    ),
  ).rejects.toHaveProperty('code', 'conflict');
  expect(
    (await apply(hub, { kind: 'materialize_profile', profileId: 'profile' }))
      .state,
  ).toBe('succeeded');
  await expect(
    hub.preview(
      {
        kind: 'set_tool_policies',
        expectedRevision: (await hub.inventory()).revision,
        expectedConnectorRevision: 1,
        connectorId: 'connector-0',
        toolPolicies: { read: 'block' },
      },
      'owner',
    ),
  ).rejects.toThrow('Dematerialize');
  await apply(hub, {
    kind: 'unassign_connector',
    profileId: 'profile',
    connectorId: 'connector-0',
  });
  await expect(
    hub.preview(
      {
        kind: 'set_tool_policies',
        expectedRevision: (await hub.inventory()).revision,
        expectedConnectorRevision: 1,
        connectorId: 'connector-0',
        toolPolicies: { read: 'block' },
      },
      'owner',
    ),
  ).rejects.toThrow('Dematerialize');
});
it('refuses materializing restrictive policies into a bypassing direct launcher', async () => {
  const state = profileState(['native']);
  state.connectors[0]!.toolPolicies = { read: 'ask' };
  const fixture = managedFixture(),
    hub = createLifecycle(
      memoryStore(state),
      Date.now,
      createMemorySafetyLedger(),
      { materializer: fixture.materializer },
    );
  cleanup.push(() => hub.close());
  await expect(
    hub.preview(
      {
        kind: 'materialize_profile',
        profileId: 'profile',
        expectedRevision: 0,
      },
      'owner',
    ),
  ).rejects.toThrow('managed agent bridge');
});
it('does not publish newly blocked tools when policies change during discovery', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    pending = new Promise<void>((resolve) => {
      started = resolve;
    }),
    f = await setup(undefined, undefined, gate, started),
    listing = f.agent.listTools();
  await pending;
  f.state.connectors[0]!.toolPolicies = { read: 'block', write: 'block' };
  f.state.revision++;
  release();
  expect((await listing).tools.map((tool) => tool.name)).toEqual([
    'connector-0__delete',
  ]);
  expect(f.calls).toEqual([]);
});
it('never reallocates a blocked alias to another connector with the same slug', async () => {
  const f = await setup();
  f.state.connectors[0]!.name = 'same slug';
  const second = structuredClone(f.state.connectors[0]!);
  second.id = 'connector-1';
  second.name = 'same_slug';
  f.state.connectors.push(second);
  const first = await f.agent.listTools();
  expect(
    first.tools.find((tool) => tool.name === 'same_slug__read'),
  ).toBeDefined();
  f.state.connectors[0]!.toolPolicies = { read: 'block' };
  f.state.connectors.reverse();
  f.state.revision++;
  expect(
    (await f.agent.listTools()).tools.map((tool) => tool.name),
  ).not.toContain('same_slug__read');
  expect(await f.agent.callTool({ name: 'same_slug__read' })).toMatchObject({
    content: [{ text: 'tool_blocked' }],
  });
  expect(f.calls).toEqual([]);
});
it('rechecks a confirmed Ask call waiting behind another peer operation', async () => {
  let release!: () => void, started!: () => void, asked!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    running = new Promise<void>((resolve) => {
      started = resolve;
    }),
    prompt = new Promise<void>((resolve) => {
      asked = resolve;
    });
  const f = await setup(
    { write: 'ask' },
    async () => {
      asked();
      return { action: 'accept', content: { approve: true } };
    },
    undefined,
    undefined,
    async (name) => {
      if (name === 'read') {
        started();
        await held;
      }
    },
  );
  await f.agent.listTools();
  const first = f.agent.callTool({ name: 'connector-0__read' });
  await running;
  const queued = f.agent.callTool({ name: 'connector-0__write' });
  await prompt;
  await new Promise((resolve) => setImmediate(resolve));
  f.state.connectors[0]!.toolPolicies = { write: 'block' };
  f.state.revision++;
  release();
  await first;
  expect(await queued).toMatchObject({
    isError: true,
    content: [{ text: 'tool_blocked' }],
  });
  expect(f.calls.map((call) => call.name)).toEqual(['read']);
});
it('rolls back a failed policy registry write without changing saved permissions', async () => {
  const store = memoryStore(profileState(['native'])),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety);
  cleanup.push(() => hub.close());
  store.write = async () => {
    throw new Error('Synthetic storage failure');
  };
  const preview = await hub.preview(
      {
        kind: 'set_tool_policies',
        expectedRevision: 0,
        expectedConnectorRevision: 1,
        connectorId: 'connector-0',
        toolPolicies: { read: 'block' },
      },
      'owner',
    ),
    job = await hub.apply(preview.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('failed');
  expect((await store.read()).connectors[0]!.toolPolicies).toBeUndefined();
  expect((await safety.read()).operations.at(-1)?.phase).toBe('aborted');
});
