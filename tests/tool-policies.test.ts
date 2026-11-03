import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createAgentBridge,
  type BridgeSession,
} from '../packages/hub-core/src/integrations/bridge.js';
import {
  ToolPoliciesSchema,
  ConnectorSchema,
  StateSchema,
} from '@waleed/contracts';
import {
  approved,
  createLifecycle,
  createMemorySafetyLedger,
} from '@waleed/hub-core';
import { profileState, apply, definition } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
import { bridgeToolName } from '../packages/hub-core/src/integrations/bridge.js';
import {
  toolPolicy,
  hasRestrictedTools,
} from '../packages/hub-core/src/runtime/tool-policy.js';
import { managedFixture } from './helpers/materialization.js';

async function fixture(
  pooled: boolean,
  elicitation: boolean | 'legacy' = true,
  options: { guard?: boolean; tools?: string[] } = {},
) {
  const state = profileState(['native']);
  if (options.guard) {
    state.connectors[0]!.defaultToolPolicy = 'block';
    state.connectors[0]!.toolPolicies = { read: 'allow' };
  }
  let toolNames = options.tools ?? ['read'];
  let afterRead: (() => void) | undefined;
  let afterSnapshot: (() => void) | undefined;
  const peers: Server[] = [];
  let changes = 0;
  const calls: unknown[] = [];
  let starts = 0,
    seq = 0;
  let startup: (() => Promise<void>) | undefined;
  const session: BridgeSession = {
    async snapshot(inside) {
      const result = {
        state: structuredClone(state),
        seq: ++seq,
        bootId: 'test',
      };
      inside?.(result);
      const hook = afterSnapshot;
      afterSnapshot = undefined;
      hook?.();
      return result;
    },
    async verify() {},
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const bridge = createAgentBridge(
    async () => {
      const snapshot = structuredClone(state);
      const hook = afterRead;
      afterRead = undefined;
      hook?.();
      return snapshot;
    },
    async () => {
      starts++;
      await startup?.();
      const peer = new Server(
        { name: 'policy-peer', version: '1' },
        { capabilities: { tools: { listChanged: true } } },
      );
      peer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: toolNames.map((name) => ({
          name,
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        })),
      }));
      peer.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push(request.params.arguments);
        return { content: [{ type: 'text', text: 'done' }] };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await peer.connect(a);
      const client = new Client({ name: 'peer-client', version: '1' });
      await client.connect(b);
      peers.push(peer);
      return {
        client,
        assertPublic() {},
        async dispose() {
          await client.close();
          await peer.close();
        },
      };
    },
    pooled ? session : undefined,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'policy-agent', version: '1' },
    {
      capabilities: elicitation
        ? { elicitation: elicitation === 'legacy' ? {} : { form: {} } }
        : {},
    },
  );
  await agent.connect(b);
  agent.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes++;
  });
  const name = (await agent.listTools()).tools[0]!.name;
  return {
    state,
    agent,
    bridge,
    calls,
    name,
    get changes() {
      return changes;
    },
    afterRead(fn: () => void) {
      afterRead = fn;
    },
    afterSnapshot(fn: () => void) {
      afterSnapshot = fn;
    },
    afterSnapshots(count: number, fn: () => void) {
      const hook = () => {
        if (--count === 0) fn();
        else afterSnapshot = hook;
      };
      afterSnapshot = hook;
    },
    async listing(names: string[]) {
      toolNames = names;
      await Promise.all(peers.map((peer) => peer.sendToolListChanged()));
    },
    get starts() {
      return starts;
    },
    startup(fn: () => Promise<void>) {
      startup = fn;
    },
    async close() {
      await agent.close();
      await bridge.close();
    },
  };
}

it('rejects malformed and prototype policy keys', () => {
  for (const input of [
    JSON.parse('{"__proto__":"allow"}'),
    { constructor: 'allow' },
    { read: 'yes' },
  ])
    expect(ToolPoliciesSchema.safeParse(input).success).toBe(false);
  expect(ToolPoliciesSchema.parse({ 'server.read': 'ask' })).toEqual({
    'server.read': 'ask',
  });
});
it('persists revision-bound policies without revoking execution approval', async () => {
  const hub = createLifecycle(
    memoryStore(profileState(['native'])),
    Date.now,
    createMemorySafetyLedger(),
  );
  try {
    const before = (await hub.inventory()).connectors[0]!;
    expect(
      (
        await apply(hub, {
          kind: 'set_tool_policies',
          connectorId: before.id,
          expectedConnectorRevision: before.revision,
          toolPolicies: { read: 'block' },
        })
      ).state,
    ).toBe('succeeded');
    const after = (await hub.inventory()).connectors[0]!;
    expect(after.toolPolicies).toEqual({ read: 'block' });
    expect(after.revision).toBe(before.revision);
    expect(approved(after)).toBe(true);
    await expect(
      hub.preview(
        {
          kind: 'set_tool_policies',
          expectedRevision: 0,
          connectorId: after.id,
          expectedConnectorRevision: after.revision,
          toolPolicies: {},
        },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  } finally {
    await hub.close();
  }
});
for (const pooled of [false, true]) {
  it(`blocks stale calls and filters catalog (pooled=${pooled})`, async () => {
    const f = await fixture(pooled);
    try {
      f.state.connectors[0]!.toolPolicies = { read: 'block' };
      expect(
        await f.agent.callTool({ name: f.name, arguments: {} }),
      ).toMatchObject({ isError: true, content: [{ text: 'tool_blocked' }] });
      expect((await f.agent.listTools()).tools).toEqual([]);
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it(`requires approval on every call, exact arguments, denies decline and stale approval (pooled=${pooled})`, async () => {
    const f = await fixture(pooled);
    let prompts = 0;
    let mode = 'accept';
    f.agent.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts++;
      expect(request.params.message).toContain('"value":7');
      if (mode === 'stale') f.state.revision++;
      return mode === 'decline'
        ? { action: 'decline' }
        : { action: 'accept', content: { approve: true } };
    });
    try {
      f.state.connectors[0]!.toolPolicies = { read: 'ask' };
      for (let n = 0; n < 2; n++)
        expect(
          (await f.agent.callTool({ name: f.name, arguments: { value: 7 } }))
            .isError,
        ).not.toBe(true);
      expect(prompts).toBe(2);
      expect(f.calls).toEqual([{ value: 7 }, { value: 7 }]);
      mode = 'decline';
      expect(
        await f.agent.callTool({ name: f.name, arguments: { value: 7 } }),
      ).toMatchObject({
        isError: true,
        content: [{ text: 'tool_approval_denied' }],
      });
      mode = 'stale';
      expect(
        await f.agent.callTool({ name: f.name, arguments: { value: 7 } }),
      ).toMatchObject({
        isError: true,
        content: [{ text: 'tool_approval_stale' }],
      });
      expect(f.calls).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it(`refuses ask on clients without elicitation (pooled=${pooled})`, async () => {
    const f = await fixture(pooled, false);
    try {
      f.state.connectors[0]!.toolPolicies = { read: 'ask' };
      expect(
        await f.agent.callTool({ name: f.name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: 'tool_approval_required' }],
      });
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it(`rechecks permission after startup (pooled=${pooled})`, async () => {
    const f = await fixture(pooled);
    try {
      if (pooled) {
        f.state.connectors[0]!.revision++;
        f.state.connectors[0]!.trustApproval!.revision++;
        await f.bridge.reconcile();
        await f.agent.listTools();
      }
      // Expire the pooled peer by changing the boot; dispatch must replace it.
      if (pooled) {
        f.state.connectors[0]!.enabled = false;
        await f.bridge.reconcile();
        f.state.connectors[0]!.enabled = true;
      }
      f.startup(async () => {
        f.state.connectors[0]!.toolPolicies = { read: 'block' };
      });
      expect(
        await f.agent.callTool({ name: f.name, arguments: {} }),
      ).toMatchObject({ isError: true, content: [{ text: 'tool_blocked' }] });
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

it('accepts empty legacy elicitation capability for one-time form approval', async () => {
  const f = await fixture(false, 'legacy');
  f.agent.setRequestHandler(ElicitRequestSchema, async () => ({
    action: 'accept',
    content: { approve: true },
  }));
  try {
    f.state.connectors[0]!.toolPolicies = { read: 'ask' };
    expect(
      (await f.agent.callTool({ name: f.name, arguments: {} })).isError,
    ).not.toBe(true);
    expect(f.calls).toEqual([{}]);
  } finally {
    await f.close();
  }
});

it('defaults legacy connectors to allow and rejects invalid defaults without widening access', () => {
  const connector = profileState(['native']).connectors[0]!;
  expect(toolPolicy(connector, 'unknown')).toBe('allow');
  expect(hasRestrictedTools(connector)).toBe(false);
  expect(
    ConnectorSchema.safeParse({ ...connector, defaultToolPolicy: 'ask' })
      .success,
  ).toBe(false);
  expect(
    toolPolicy(
      { ...connector, defaultToolPolicy: 'invalid' } as never,
      'unknown',
    ),
  ).toBe('block');
  expect(
    toolPolicy({ ...connector, defaultToolPolicy: null } as never, 'unknown'),
  ).toBe('block');
  expect(
    hasRestrictedTools({ ...connector, defaultToolPolicy: null } as never),
  ).toBe(true);
  connector.defaultToolPolicy = 'block';
  connector.toolPolicies = { read: 'allow', dangerous: 'block' };
  expect(toolPolicy(connector, 'read')).toBe('allow');
  expect(toolPolicy(connector, 'unknown')).toBe('block');
  expect(hasRestrictedTools(connector)).toBe(true);
  // The strict pre-feature native consumer refuses the new guarded field.
  const oldNative = ConnectorSchema.options[1].omit({
    defaultToolPolicy: true,
  });
  expect(oldNative.safeParse(connector).success).toBe(false);
});

it('persists default-block, preserves it through legacy policy saves and connector edits, and keeps execution approval separate', async () => {
  const hub = createLifecycle(
    memoryStore(profileState(['native'])),
    Date.now,
    createMemorySafetyLedger(),
  );
  try {
    const original = (await hub.inventory()).connectors[0]!;
    await apply(hub, {
      kind: 'set_tool_policies',
      connectorId: original.id,
      expectedConnectorRevision: original.revision,
      defaultToolPolicy: 'block',
      toolPolicies: { read: 'allow' },
    });
    let state = await hub.inventory();
    expect(state.revision).toBe(1);
    expect(state.connectors[0]!.defaultToolPolicy).toBe('block');
    expect(state.connectors[0]!.revision).toBe(original.revision);
    expect(approved(state.connectors[0]!)).toBe(true);
    expect(
      StateSchema.parse(JSON.parse(JSON.stringify(state))).connectors[0]!
        .defaultToolPolicy,
    ).toBe('block');
    await apply(hub, {
      kind: 'set_tool_policies',
      connectorId: original.id,
      expectedConnectorRevision: original.revision,
      toolPolicies: {},
    });
    expect((await hub.inventory()).connectors[0]!.defaultToolPolicy).toBe(
      'block',
    );
    await apply(hub, {
      kind: 'edit_connector',
      connectorId: original.id,
      definition: definition({
        id: original.id,
        name: 'Edited',
        command: 'C:\\Synthetic Space\\node.exe',
        args: ['fixture.js'],
      }),
    });
    state = await hub.inventory();
    expect(state.connectors[0]!.defaultToolPolicy).toBe('block');
    await apply(hub, {
      kind: 'set_tool_policies',
      connectorId: original.id,
      expectedConnectorRevision: state.connectors[0]!.revision,
      defaultToolPolicy: 'allow',
      toolPolicies: {},
    });
    expect(
      (await hub.inventory()).connectors[0]!.defaultToolPolicy,
    ).toBeUndefined();
  } finally {
    await hub.close();
  }
});

for (const pooled of [false, true]) {
  it(`publishes all 30 explicit allows and refuses unknown names without an upstream call (pooled=${pooled})`, async () => {
    const reviewed = Array.from({ length: 30 }, (_, i) => `reviewed-${i}`);
    const f = await fixture(pooled, true, {
      guard: true,
      tools: ['read', ...reviewed, 'new-admin', 'dangerous'],
    });
    try {
      f.state.connectors[0]!.toolPolicies = {
        ...Object.fromEntries(reviewed.map((name) => [name, 'allow'] as const)),
        dangerous: 'block',
      };
      const list = await f.agent.listTools();
      expect(list.tools).toHaveLength(30);
      expect(list.tools.map((t) => t.name)).toEqual(
        reviewed.map((name) => bridgeToolName(f.state.connectors[0]!, name)),
      );
      const starts = f.starts;
      for (const name of ['new-admin', 'dangerous']) {
        expect(
          (
            await f.agent.callTool({
              name: bridgeToolName(f.state.connectors[0]!, name),
              arguments: {},
            })
          ).isError,
        ).toBe(true);
      }
      expect(f.calls).toEqual([]);
      expect(f.starts).toBe(starts);
      await f.agent.callTool({ name: list.tools[0]!.name, arguments: {} });
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it(`revokes stale published calls when only the default changes (pooled=${pooled})`, async () => {
    const f = await fixture(pooled);
    try {
      f.state.connectors[0]!.defaultToolPolicy = 'block';
      const starts = f.starts;
      expect(
        await f.agent.callTool({ name: f.name, arguments: {} }),
      ).toMatchObject({ isError: true, content: [{ text: 'tool_blocked' }] });
      expect(f.starts).toBe(starts);
      expect(f.calls).toEqual([]);
      expect((await f.agent.listTools()).tools).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it(`does not dispatch a call whose first permissive snapshot was overtaken by default revocation (pooled=${pooled})`, async () => {
    const f = await fixture(pooled);
    try {
      const revoke = () => {
        f.state.connectors[0]!.defaultToolPolicy = 'block';
        f.state.revision++;
      };
      // Snapshot 1 admits the route. Snapshot 2 was formerly awaited and
      // authorized after its callback returned: revoke in that await gap.
      if (pooled) f.afterSnapshots(2, revoke);
      else f.afterRead(revoke);
      expect(
        (await f.agent.callTool({ name: f.name, arguments: {} })).isError,
      ).toBe(true);
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it(`binds one-time approval to the default as well as named rules (pooled=${pooled})`, async () => {
    const f = await fixture(pooled);
    try {
      f.state.connectors[0]!.toolPolicies = { read: 'ask' };
      f.agent.setRequestHandler(ElicitRequestSchema, async () => {
        f.state.connectors[0]!.defaultToolPolicy = 'block';
        return { action: 'accept', content: { approve: true } };
      });
      expect(
        await f.agent.callTool({ name: f.name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: 'tool_approval_stale' }],
      });
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it(`does not dispatch after default-block is enabled during peer startup (pooled=${pooled})`, async () => {
    const f = await fixture(pooled);
    try {
      if (pooled) {
        f.state.connectors[0]!.enabled = false;
        await f.bridge.reconcile();
        f.state.connectors[0]!.enabled = true;
      }
      f.startup(async () => {
        f.state.connectors[0]!.defaultToolPolicy = 'block';
      });
      expect(
        (await f.agent.callTool({ name: f.name, arguments: {} })).isError,
      ).toBe(true);
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

it('keeps newly announced tools closed across tools/list_changed', async () => {
  const f = await fixture(true, true, { guard: true });
  try {
    await f.listing(['read', 'unreviewed-admin']);
    await expect.poll(() => f.changes).toBeGreaterThan(0);
    expect((await f.agent.listTools()).tools.map((tool) => tool.name)).toEqual([
      f.name,
    ]);
    expect(
      (
        await f.agent.callTool({
          name: bridgeToolName(f.state.connectors[0]!, 'unreviewed-admin'),
          arguments: {},
        })
      ).isError,
    ).toBe(true);
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const mode of ['native', 'docker', 'remote'] as const) {
  it(`refuses a default-block direct snapshot even when all named rules allow (${mode})`, async () => {
    const state = profileState([mode]);
    state.connectors[0]!.defaultToolPolicy = 'block';
    state.connectors[0]!.toolPolicies = { read: 'allow' };
    const f = managedFixture();
    await expect(
      f.materializer.plan(
        state,
        'profile',
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.disk.size).toBe(0);
    expect(f.profiles.size).toBe(0);
  });
}

it('refuses default-block policy mutation while a direct snapshot exists', async () => {
  const state = profileState(['native']);
  state.materializations = [
    {
      profileId: 'profile',
      profileRevision: state.profiles[0]!.revision,
      dockerProfileId: null,
      configurationHash: 'a'.repeat(64),
      dockerHash: null,
      files: [],
      appliedAt: '2026-10-28T00:00:00.000Z',
    },
  ];
  const hub = createLifecycle(
    memoryStore(state),
    Date.now,
    createMemorySafetyLedger(),
  );
  try {
    await expect(
      hub.preview(
        {
          kind: 'set_tool_policies',
          connectorId: state.connectors[0]!.id,
          expectedRevision: 0,
          expectedConnectorRevision: state.connectors[0]!.revision,
          defaultToolPolicy: 'block',
          toolPolicies: { read: 'allow' },
        },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  } finally {
    await hub.close();
  }
});
