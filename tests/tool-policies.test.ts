import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createAgentBridge,
  type BridgeSession,
} from '../packages/hub-core/src/integrations/bridge.js';
import { ToolPoliciesSchema } from '@waleed/contracts';
import {
  approved,
  createLifecycle,
  createMemorySafetyLedger,
} from '@waleed/hub-core';
import { profileState, apply } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';

async function fixture(pooled: boolean, elicitation = true) {
  const state = profileState(['native']);
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
      return result;
    },
    async verify() {},
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const bridge = createAgentBridge(
    async () => structuredClone(state),
    async () => {
      starts++;
      await startup?.();
      const peer = new Server(
        { name: 'policy-peer', version: '1' },
        { capabilities: { tools: {} } },
      );
      peer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'read',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
      }));
      peer.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push(request.params.arguments);
        return { content: [{ type: 'text', text: 'done' }] };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await peer.connect(a);
      const client = new Client({ name: 'peer-client', version: '1' });
      await client.connect(b);
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
    { capabilities: elicitation ? { elicitation: { form: {} } } : {} },
  );
  await agent.connect(b);
  const name = (await agent.listTools()).tools[0]!.name;
  return {
    state,
    agent,
    bridge,
    calls,
    name,
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
