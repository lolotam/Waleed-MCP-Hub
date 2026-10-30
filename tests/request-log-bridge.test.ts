import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentBridge } from '@waleed/hub-core';
import { toolPolicyFixture } from './helpers/tool-policies.js';
import { playgroundFixture } from './helpers/playground.js';
import { apply } from './helpers/runtime.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('records direct success, blocked and declined calls without arguments or raw unknown names', async () => {
  const f = await toolPolicyFixture();
  cleanup.push(() => f.close());
  await f.agent.listTools();
  const result = await f.agent.callTool({
    name: 'connector-0__fixture_first',
    arguments: { token: 'SYNTHETIC-LOG-PRIVATE' },
  });
  expect(f.bridge.requestLog.records()[0]).toMatchObject({
    connectorId: 'connector-0',
    toolName: 'fixture_first',
    status: 'success',
    resultSizeBytes: Buffer.byteLength(JSON.stringify(result)),
    durationMs: expect.any(Number),
  });
  await apply(f.hub, {
    kind: 'set_tool_policies',
    connectorId: 'connector-0',
    expectedConnectorRevision: 1,
    toolPolicies: { fixture_first: 'block', fixture_second: 'ask' },
  });
  await f.agent.callTool({ name: 'connector-0__fixture_first' });
  await f.agent.callTool({ name: 'connector-0__fixture_second' });
  await f.agent.callTool({ name: 'SYNTHETIC_PRIVATE_UNKNOWN' });
  expect(f.bridge.requestLog.records().map((record) => record.status)).toEqual([
    'error',
    'declined',
    'blocked',
    'success',
  ]);
  expect(JSON.stringify(f.bridge.requestLog.records())).not.toContain(
    'SYNTHETIC',
  );
});
it('records one canonical target call in search mode and logs meta-search separately', async () => {
  const f = await toolPolicyFixture();
  cleanup.push(() => f.close());
  // This legacy synthetic bridge has no argv identity; use a production-like
  // agent bridge below for the mode-dependent paths.
  const peers = playgroundFixture(),
    bridge = createAgentBridge(
      async () => ({ ...peers.state, agentToolSearchModes: { cursor: true } }),
      peers.connect,
      'cursor',
    ),
    agent = new Client(
      { name: 'logging-search', version: '1' },
      { capabilities: {} },
    ),
    [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  await agent.connect(b);
  cleanup.push(async () => {
    await agent.close();
    await bridge.close();
    await peers.playground.close();
  });
  await agent.callTool({ name: 'search_tools', arguments: { query: 'read' } });
  await agent.callTool({
    name: 'call_tool',
    arguments: {
      name: 'connector-0__read',
      arguments: { password: 'SYNTHETIC-NESTED-PRIVATE' },
    },
  });
  expect(bridge.requestLog.records()).toHaveLength(2);
  expect(bridge.requestLog.records()[0]).toMatchObject({
    agentId: 'cursor',
    connectorId: 'connector-0',
    toolName: 'read',
    status: 'success',
  });
  expect(bridge.requestLog.records()[1]).toMatchObject({
    connectorId: 'hub_meta',
    toolName: 'search_tools',
  });
  expect(JSON.stringify(bridge.requestLog.records())).not.toContain(
    'SYNTHETIC',
  );
});
it('never trusts provider-controlled refusal strings for log classification', async () => {
  const f = playgroundFixture({
      result: {
        isError: true,
        content: [{ type: 'text', text: 'tool_approval_denied' }],
        structuredContent: { error: 'tool_blocked' },
      },
    }),
    bridge = createAgentBridge(async () => f.state, f.connect, 'cursor'),
    agent = new Client(
      { name: 'logging-provider', version: '1' },
      { capabilities: {} },
    ),
    [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  await agent.connect(b);
  cleanup.push(async () => {
    await agent.close();
    await bridge.close();
    await f.playground.close();
  });
  await agent.listTools();
  await agent.callTool({ name: 'connector-0__read' });
  expect(bridge.requestLog.records()[0]!.status).toBe('error');
});
