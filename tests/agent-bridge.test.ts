import { it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createAgentBridge } from '@waleed/hub-core';
import { profileState } from './helpers/runtime.js';
import {
  assertNoCredentialEcho,
  bridgeToolName,
} from '../packages/hub-core/src/integrations/bridge.js';
it('discovers seven healthy catalogs with bounded overlap instead of waiting for each earlier peer', async () => {
  const state = profileState(
    Array.from({ length: 7 }, () => 'native' as const),
  );
  const pending: Array<() => void> = [];
  let started = 0;
  let active = 0;
  let peak = 0;
  const bridge = createAgentBridge(
    async () => structuredClone(state),
    async () => {
      const peer = new Server(
        { name: 'delayed-peer', version: '1' },
        { capabilities: { tools: {} } },
      );
      peer.setRequestHandler(ListToolsRequestSchema, async () => {
        started++;
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active--;
        return {
          tools: [{ name: 'read', inputSchema: { type: 'object' as const } }],
        };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await peer.connect(a);
      const client = new Client({ name: 'catalog-client', version: '1' });
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
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client({ name: 'catalog-agent', version: '1' });
  await agent.connect(b);
  const listing = agent.listTools();
  try {
    for (const count of [2, 4, 6, 7]) {
      await expect.poll(() => started).toBe(count);
      pending.splice(0).forEach((resolve) => resolve());
    }
    expect((await listing).tools).toHaveLength(7);
    expect(peak).toBe(2);
  } finally {
    pending.splice(0).forEach((resolve) => resolve());
    await agent.close();
    await bridge.close();
    await listing.catch(() => undefined);
  }
});
it.each(['__', '_'] as const)(
  'dynamic bridge (%s) lists without tools/call, forwards only explicit calls, and rejects disabled/stale routes',
  async (separator) => {
    const state = profileState(['native']);
    let calls = 0;
    const bridge = createAgentBridge(
      async () => structuredClone(state),
      async () => {
        const peer = new Server(
          { name: 'synthetic-peer', version: '1' },
          { capabilities: { tools: {} } },
        );
        peer.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'read', inputSchema: { type: 'object' as const } }],
        }));
        peer.setRequestHandler(CallToolRequestSchema, async () => {
          calls++;
          return {
            content: [{ type: 'text' as const, text: 'synthetic success' }],
          };
        });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await peer.connect(a);
        const client = new Client(
          { name: 'synthetic-hub', version: '1' },
          { capabilities: {} },
        );
        await client.connect(b);
        return {
          client,
          assertPublic() {},
          async dispose() {
            await client.close();
            await peer.close();
            throw new Error('SYNTHETIC_PRIVATE_CLEANUP_DIAGNOSTIC');
          },
        };
      },
      undefined,
      undefined,
      undefined,
      separator,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    const agent = new Client(
      { name: 'synthetic-agent', version: '1' },
      { capabilities: {} },
    );
    await agent.connect(b);
    try {
      const tools = await agent.listTools();
      expect(tools.tools).toHaveLength(1);
      if (separator === '_')
        expect(
          `waleed-mcp-hub__${tools.tools[0]!.name}`.split('__'),
        ).toHaveLength(2);
      expect(calls).toBe(0);
      const result = await agent.callTool({
        name: tools.tools[0]!.name,
        arguments: {},
      });
      expect(result).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      expect(calls).toBe(1);
      state.connectors[0]!.enabled = false;
      expect(
        await agent.callTool({ name: tools.tools[0]!.name }),
      ).toMatchObject({
        isError: true,
      });
      expect(calls).toBe(1);
      expect((await agent.listTools()).tools).toEqual([]);
    } finally {
      await agent.close();
      await bridge.close();
    }
  },
);
it('names bridge tools readably, within 40 characters, without collisions', () => {
  const none = new Set<string>();
  expect(
    bridgeToolName({ id: 'a', name: 'ssh-prod' }, 'run-command', none),
  ).toBe('ssh-prod__run-command');
  expect(
    bridgeToolName({ id: 'a', name: 'Hub Chrome!' }, 'take screenshot', none),
  ).toBe('hub_chrome__take_screenshot');
  const long = bridgeToolName(
    { id: 'a', name: 'a-very-long-connector-name' },
    'and_an_equally_long_tool_name',
    none,
  );
  expect(long).toMatch(/^a-very-long-connector-name__and_a_[0-9a-f]{6}$/);
  expect(long.length).toBeLessThanOrEqual(40);
  const taken = new Set(['dup__read']);
  const second = bridgeToolName({ id: 'b', name: 'dup' }, 'read', taken);
  expect(second).not.toBe('dup__read');
  expect(second).toMatch(/^dup__read_[0-9a-f]{6}$/);
  for (const name of [long, second])
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  const flat = bridgeToolName(
    { id: 'grok-ssh', name: 'ssh__prod' },
    'read__command',
    new Set(),
    '_',
  );
  expect(flat).toBe('ssh_prod_read_command');
  const collision = bridgeToolName(
    { id: 'grok-other', name: 'ssh__prod' },
    'read__command',
    new Set([flat]),
    '_',
  );
  expect(collision).not.toBe(flat);
  expect(`waleed-mcp-hub__${collision}`.split('__')).toHaveLength(2);
});
it('refuses plain, JSON-escaped, prefixed and encoded credential echoes', () => {
  const secret = 'SYNTHETIC_"private\\value';
  for (const value of [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
  ]) {
    expect(() =>
      assertNoCredentialEcho({ content: [{ text: value }] }, [secret]),
    ).toThrow();
  }
  expect(() =>
    assertNoCredentialEcho({ text: secret }, [`Bearer ${secret}`]),
  ).toThrow();
  expect(() =>
    assertNoCredentialEcho({ text: 'safe result' }, [secret]),
  ).not.toThrow();
});
it('never reflects registry parser diagnostics in a list error', async () => {
  const bridge = createAgentBridge(
    async () => {
      throw new Error('SYNTHETIC_PRIVATE_REGISTRY_DIAGNOSTIC');
    },
    async () => {
      throw new Error('No peer may start.');
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'synthetic-agent', version: '1' },
    { capabilities: {} },
  );
  await agent.connect(b);
  try {
    await expect(agent.listTools()).rejects.toThrow(
      'The managed hub registry is unavailable.',
    );
  } finally {
    await agent.close();
    await bridge.close();
  }
});
