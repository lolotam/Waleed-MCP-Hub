import { afterEach, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ToolListChangedNotificationSchema,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  StateSchema,
  AgentProfileBindingsSchema,
  type IntegrationAgentId,
  type CapabilityObservation,
} from '@waleed/contracts';
import {
  createAgentBridge,
  createLifecycle,
  createMemorySafetyLedger,
  definitionHash,
  approved,
} from '@waleed/hub-core';
import { profileState, apply } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function initial() {
  const state = profileState(['native', 'native', 'native']);
  state.profiles[0]!.connectorIds = ['connector-0'];
  state.profiles.push({
    ...state.profiles[0]!,
    id: 'other',
    name: 'Other',
    connectorIds: ['connector-1'],
  });
  return state;
}
async function setup(
  state = initial(),
  agentId: IntegrationAgentId | undefined = 'cursor',
  options: {
    confirm?: () => Promise<ElicitResult>;
    listGate?: Promise<void>;
    listed?: () => void;
    callGate?: Promise<void>;
    called?: () => void;
  } = {},
) {
  const starts: string[] = [],
    calls: string[] = [],
    closed: string[] = [];
  const bridge = createAgentBridge(
    async () => structuredClone(state),
    async (connector) => {
      starts.push(connector.id);
      const peer = new Server(
        { name: 'synthetic-agent-profile-peer', version: '1' },
        { capabilities: { tools: {} } },
      );
      peer.setRequestHandler(ListToolsRequestSchema, async () => {
        options.listed?.();
        await options.listGate;
        return {
          tools: [
            {
              name: 'read',
              description: `Synthetic tool for ${connector.id}`,
              inputSchema: { type: 'object' as const },
            },
          ],
        };
      });
      peer.setRequestHandler(CallToolRequestSchema, async () => {
        calls.push(connector.id);
        options.called?.();
        await options.callGate;
        return {
          content: [
            { type: 'text' as const, text: `Synthetic ${connector.id} result` },
          ],
        };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await peer.connect(a);
      const client = new Client(
        { name: 'profile-test-hub', version: '1' },
        { capabilities: {} },
      );
      await client.connect(b);
      return {
        client,
        assertPublic() {},
        async dispose() {
          closed.push(connector.id);
          await client.close();
          await peer.close();
        },
      };
    },
    agentId,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'profile-test-agent', version: '1' },
    { capabilities: options.confirm ? { elicitation: { form: {} } } : {} },
  );
  if (options.confirm)
    agent.setRequestHandler(ElicitRequestSchema, options.confirm);
  await agent.connect(b);
  cleanup.push(async () => {
    await agent.close();
    await bridge.close();
  });
  return { state, agent, bridge, starts, calls, closed };
}
it('preserves legacy state without adding implicit assignments', () => {
  const state = initial();
  expect(StateSchema.parse(state)).not.toHaveProperty('agentProfileBindings');
  expect(AgentProfileBindingsSchema.parse({ cursor: 'profile' })).toEqual({
    cursor: 'profile',
  });
});
it('rejects malformed target agents rather than silently using unrestricted defaults', () => {
  expect(() =>
    createAgentBridge(
      async () => initial(),
      async () => {
        throw new Error('No start');
      },
      'unknown' as IntegrationAgentId,
    ),
  ).toThrow();
  expect(AgentProfileBindingsSchema.safeParse({ cursor: null }).success).toBe(
    false,
  );
});
it.each(['unknown', 'constructor', 'prototype', '__proto__'])(
  'rejects forbidden agent mapping key %s',
  (key) =>
    expect(
      AgentProfileBindingsSchema.safeParse(JSON.parse(`{"${key}":"profile"}`))
        .success,
    ).toBe(false),
);
it.each(['', '../profile', 'C:\\path', 'x'.repeat(81)])(
  'rejects invalid profile identifiers %j',
  (profileId) =>
    expect(
      AgentProfileBindingsSchema.safeParse({ cursor: profileId }).success,
    ).toBe(false),
);
it('rejects assignments to missing profiles without requiring every supported agent key', () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'missing' };
  expect(StateSchema.safeParse(state).success).toBe(false);
  state.agentProfileBindings = { cursor: 'profile', codex: 'other' };
  expect(StateSchema.safeParse(state).success).toBe(true);
});
it('unassigned agents retain all enabled approved connectors', async () => {
  const f = await setup();
  expect((await f.agent.listTools()).tools).toHaveLength(3);
  await f.agent.callTool({ name: 'connector-2__read' });
  expect(f.calls).toEqual(['connector-2']);
});
it.each(['cursor', 'codex'] as const)(
  'filters %s by its own assignment before connecting or disclosing tools',
  async (agentId) => {
    const state = initial();
    state.agentProfileBindings = { cursor: 'profile', codex: 'other' };
    const f = await setup(state, agentId),
      expected = agentId === 'cursor' ? 'connector-0' : 'connector-1',
      catalog = await f.agent.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      `${expected}__read`,
    ]);
    expect(f.starts).toEqual([expected]);
    await f.agent.callTool({ name: `${expected}__read` });
    expect(f.calls).toEqual([expected]);
  },
);
it('denies stale handles after an agent is assigned a restrictive profile', async () => {
  const f = await setup();
  await f.agent.listTools();
  f.state.agentProfileBindings = { cursor: 'profile' };
  f.state.revision++;
  expect(await f.agent.callTool({ name: 'connector-2__read' })).toMatchObject({
    isError: true,
    content: [{ text: 'tool_scope_denied' }],
  });
  expect(f.calls).toEqual([]);
});
it.each(['empty', 'disabled', 'missing'] as const)(
  'fails closed for an assigned %s profile',
  async (condition) => {
    const state = initial();
    state.agentProfileBindings = {
      cursor: condition === 'missing' ? 'missing' : 'profile',
    };
    if (condition === 'empty') state.profiles[0]!.connectorIds = [];
    if (condition === 'disabled') state.profiles[0]!.enabled = false;
    const f = await setup(state);
    expect((await f.agent.listTools()).tools).toEqual([]);
    expect(f.starts).toEqual([]);
    expect(
      await f.agent.callTool({ name: 'connector-0__read' }),
    ).toHaveProperty('isError', true);
    expect(f.calls).toEqual([]);
  },
);
it('notifies and retires scoped sessions when membership or assignment changes', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile' };
  const f = await setup(state);
  await f.agent.listTools();
  let notifications = 0;
  f.agent.setNotificationHandler(
    ToolListChangedNotificationSchema,
    async () => {
      notifications++;
    },
  );
  state.profiles[0]!.connectorIds = [];
  state.profiles[0]!.revision++;
  state.revision++;
  await f.bridge.refresh();
  expect(f.closed).toContain('connector-0');
  expect(await f.agent.callTool({ name: 'connector-0__read' })).toMatchObject({
    content: [{ text: 'tool_scope_denied' }],
  });
  expect((await f.agent.listTools()).tools).toEqual([]);
  delete state.agentProfileBindings!.cursor;
  state.revision++;
  await f.bridge.refresh();
  expect((await f.agent.listTools()).tools).toHaveLength(3);
  expect(notifications).toBe(2);
});
it('does not publish out-of-profile tools after membership changes during discovery', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile' };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    pending = new Promise<void>((resolve) => {
      started = resolve;
    }),
    f = await setup(state, 'cursor', { listGate: gate, listed: started }),
    listing = f.agent.listTools();
  await pending;
  state.profiles[0]!.connectorIds = [];
  state.profiles[0]!.revision++;
  state.revision++;
  release();
  expect((await listing).tools).toEqual([]);
  expect(f.calls).toEqual([]);
});
it('rechecks profile access after Ask approval and refuses the removed connector', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile' };
  state.connectors[0]!.toolPolicies = { read: 'ask' };
  let answer!: (value: ElicitResult) => void, started!: () => void;
  const prompt = new Promise<void>((resolve) => {
      started = resolve;
    }),
    f = await setup(state, 'cursor', {
      confirm: async () => {
        started();
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
  await f.agent.listTools();
  const call = f.agent.callTool({ name: 'connector-0__read' });
  await prompt;
  state.agentProfileBindings.cursor = 'other';
  state.revision++;
  answer({ action: 'accept', content: { approve: true } });
  expect(await call).toMatchObject({
    content: [{ text: 'tool_scope_denied' }],
  });
  expect(f.calls).toEqual([]);
});
it('retains tool-policy Block within an allowed profile and never includes disabled/unapproved members', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile' };
  state.profiles[0]!.connectorIds = state.connectors.map(
    (connector) => connector.id,
  );
  state.connectors[0]!.toolPolicies = { read: 'block' };
  state.connectors[1]!.enabled = false;
  state.connectors[2]!.trustApproval = null;
  const f = await setup(state);
  expect((await f.agent.listTools()).tools).toEqual([]);
  expect(f.starts).toEqual(['connector-0']);
  expect(await f.agent.callTool({ name: 'connector-0__read' })).toMatchObject({
    content: [{ text: 'tool_blocked' }],
  });
  expect(f.calls).toEqual([]);
});
it('persists journaled assignments with CAS, preserving code approval and profile contents', async () => {
  const state = initial(),
    store = memoryStore(state),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety);
  cleanup.push(() => hub.close());
  const input = {
      kind: 'set_agent_profile',
      expectedRevision: 0,
      agentId: 'cursor',
      profileId: 'profile',
    },
    first = await hub.preview(input, 'owner'),
    second = await hub.preview(
      { ...input, agentId: 'codex', profileId: 'other' },
      'owner',
    );
  expect(first.affectedAgents).toContain('cursor');
  const job = await hub.apply(first.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('succeeded');
  await expect(hub.apply(second.id, 'owner')).rejects.toHaveProperty(
    'code',
    'conflict',
  );
  const saved = await hub.inventory();
  expect(saved.agentProfileBindings).toEqual({ cursor: 'profile' });
  expect(saved.profiles).toEqual(state.profiles);
  expect(approved(saved.connectors[0]!)).toBe(true);
  expect(saved.connectors[0]!.revision).toBe(1);
  expect((await safety.read()).operations.at(-1)?.phase).toBe('committed');
  expect(
    StateSchema.parse(JSON.parse(JSON.stringify(saved))).agentProfileBindings,
  ).toEqual({ cursor: 'profile' });
  expect(
    (
      await apply(hub, {
        kind: 'set_agent_profile',
        agentId: 'codex',
        profileId: 'other',
      })
    ).state,
  ).toBe('succeeded');
  expect((await hub.inventory()).agentProfileBindings).toEqual({
    cursor: 'profile',
    codex: 'other',
  });
});
it('requires explicit reassignment before profile deletion, avoiding accidental fallback to All', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile' };
  const hub = createLifecycle(memoryStore(state));
  cleanup.push(() => hub.close());
  await expect(
    hub.preview(
      { kind: 'remove_profile', expectedRevision: 0, profileId: 'profile' },
      'owner',
    ),
  ).rejects.toHaveProperty('code', 'conflict');
  await expect(
    hub.preview(
      {
        kind: 'set_agent_profile',
        expectedRevision: 0,
        agentId: 'cursor',
        profileId: 'missing',
      },
      'owner',
    ),
  ).rejects.toHaveProperty('code', 'not_found');
  expect(
    (
      await apply(hub, {
        kind: 'set_agent_profile',
        agentId: 'cursor',
        profileId: null,
      })
    ).state,
  ).toBe('succeeded');
  expect(
    (await apply(hub, { kind: 'remove_profile', profileId: 'profile' })).state,
  ).toBe('succeeded');
  expect((await hub.inventory()).agentProfileBindings).toEqual({});
});
it('rolls back an unsuccessful mapping write with no partial assignment', async () => {
  const store = memoryStore(initial()),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety);
  cleanup.push(() => hub.close());
  store.write = async () => {
    throw new Error('Synthetic write failure');
  };
  const preview = await hub.preview(
      {
        kind: 'set_agent_profile',
        expectedRevision: 0,
        agentId: 'cursor',
        profileId: 'profile',
      },
      'owner',
    ),
    job = await hub.apply(preview.id, 'owner');
  await hub.drain();
  expect(hub.job(job.id, 'owner').state).toBe('failed');
  expect((await store.read()).agentProfileBindings).toBeUndefined();
  expect((await safety.read()).operations.at(-1)?.phase).toBe('aborted');
});
it('withholds an in-flight result after profile access is revoked without replaying the call', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile' };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    running = new Promise<void>((resolve) => {
      started = resolve;
    }),
    f = await setup(state, 'cursor', { callGate: gate, called: started });
  await f.agent.listTools();
  const call = f.agent.callTool({ name: 'connector-0__read' });
  await running;
  state.profiles[0]!.connectorIds = [];
  state.profiles[0]!.revision++;
  state.revision++;
  release();
  expect(await call).toMatchObject({
    content: [{ text: 'tool_scope_denied' }],
  });
  expect(f.calls).toEqual(['connector-0']);
});
it('denies a queued call when its connector leaves the assigned profile', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile' };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    running = new Promise<void>((resolve) => {
      started = resolve;
    }),
    f = await setup(state, 'cursor', { callGate: gate, called: started });
  await f.agent.listTools();
  const first = f.agent.callTool({ name: 'connector-0__read' });
  await running;
  const queued = f.agent.callTool({ name: 'connector-0__read' });
  await new Promise((resolve) => setImmediate(resolve));
  state.agentProfileBindings.cursor = 'other';
  state.revision++;
  release();
  for (const result of await Promise.all([first, queued]))
    expect(result).toMatchObject({ content: [{ text: 'tool_scope_denied' }] });
  expect(f.calls).toEqual(['connector-0']);
});
it('reports policy-aware observed counts without starting connectors, and labels unchecked ones', async () => {
  const state = initial();
  state.agentProfileBindings = { cursor: 'profile', codex: 'other' };
  state.connectors[0]!.toolPolicies = { write: 'block' };
  const hub = createLifecycle(memoryStore(state));
  cleanup.push(() => hub.close());
  const observation: CapabilityObservation = {
    connectorId: 'connector-0',
    revision: 1,
    definitionHash: definitionHash(state.connectors[0]!),
    state: 'connected',
    checkedAt: new Date().toISOString(),
    method: 'mcp_discovery',
    protocolVersion: '2025-11-25',
    tools: [
      { name: 'read', role: 'upstream' },
      { name: 'write', role: 'upstream' },
    ],
    resourceCount: 0,
    promptCount: 0,
    reason: 'none',
  };
  const result = await hub.integrations.toolSets([observation]);
  expect(
    result.toolSets.find((item) => item.agentId === 'cursor'),
  ).toMatchObject({
    profileId: 'profile',
    connectorCount: 1,
    toolCount: 1,
    unverifiedConnectorCount: 0,
  });
  expect(
    result.toolSets.find((item) => item.agentId === 'codex'),
  ).toMatchObject({
    profileId: 'other',
    connectorCount: 1,
    toolCount: 0,
    unverifiedConnectorCount: 1,
  });
  expect(
    result.toolSets.find((item) => item.agentId === 'claude'),
  ).toMatchObject({
    profileId: null,
    connectorCount: 3,
    toolCount: 1,
    unverifiedConnectorCount: 2,
  });
});
