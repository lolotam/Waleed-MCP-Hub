import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createAgentBridge, definitionHash } from '@waleed/hub-core';
import type { BridgePeer } from '../packages/hub-core/src/integrations/bridge.js';
import { assertNoCredentialEcho } from '../packages/hub-core/src/integrations/bridge.js';
import { profileState } from './helpers/runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  options: {
    idleTimeoutMs?: number;
    maxLifetimeMs?: number;
    maxPeers?: number;
  } = {},
  count = 1,
) {
  const state = profileState(
    Array.from({ length: count }, () => 'native' as const),
  );
  let readFailure = false;
  let starts = 0,
    calls = 0,
    disposed = 0;
  const peers: BridgePeer[] = [];
  const lifetimes: AbortSignal[] = [];
  const leases: Buffer[] = [];
  const hold = {
    startup: undefined as ReturnType<typeof deferred> | undefined,
    call: undefined as ReturnType<typeof deferred> | undefined,
    dispose: undefined as ReturnType<typeof deferred> | undefined,
  };
  let expiresAt: number | undefined;
  const read = async () => {
    if (readFailure) throw new Error('SYNTHETIC_PRIVATE_REGISTRY');
    return structuredClone(state);
  };
  const bridge = createAgentBridge(
    read,
    async (_connector, lifetime) => {
      starts++;
      lifetimes.push(lifetime);
      await hold.startup?.promise;
      const sessions = new Map<string, string>();
      const peer = new Server(
        { name: 'synthetic-stateful', version: '1' },
        { capabilities: { tools: {} } },
      );
      peer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          'open-session',
          'read-session-output',
          'leak',
          'fail',
          'tool-error',
        ].map((name) => ({ name, inputSchema: { type: 'object' as const } })),
      }));
      peer.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls++;
        await hold.call?.promise;
        const name = String(request.params.arguments?.name ?? 'work');
        if (request.params.name === 'open-session')
          sessions.set(name, 'stateful synthetic output');
        if (request.params.name === 'fail')
          throw new Error('SYNTHETIC_PRIVATE_PROVIDER');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                request.params.name === 'leak'
                  ? 'SYNTHETIC_PRIVATE_CREDENTIAL'
                  : (sessions.get(name) ?? 'no session'),
            },
          ],
          ...(request.params.name === 'tool-error' ? { isError: true } : {}),
        };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await peer.connect(a);
      const client = new Client(
        { name: 'synthetic-peer', version: '1' },
        { capabilities: {} },
      );
      await client.connect(b);
      const lease = Buffer.from('SYNTHETIC_PRIVATE_CREDENTIAL');
      leases.push(lease);
      const result: BridgePeer = {
        client,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        assertPublic(value) {
          assertNoCredentialEcho(value, [lease.toString()]);
        },
        async dispose() {
          disposed++;
          await hold.dispose?.promise;
          try {
            await client.close();
            await peer.close();
          } finally {
            lease.fill(0);
          }
        },
      };
      peers.push(result);
      return result;
    },
    options,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'synthetic-agent', version: '1' },
    { capabilities: {} },
  );
  await agent.connect(b);
  const close = async () => {
    hold.startup?.resolve();
    hold.call?.resolve();
    hold.dispose?.resolve();
    await agent.close();
    await bridge.close();
  };
  cleanups.push(close);
  const call = (tool: string, name = 'work', index = 0) =>
    agent.callTool({
      name: `connector-${index}__${tool}`,
      arguments: { name },
    });
  return {
    state,
    bridge,
    agent,
    peers,
    lifetimes,
    leases,
    hold,
    call,
    close,
    stats: () => ({ starts, calls, disposed }),
    failRead: () => {
      readFailure = true;
    },
    expires: (time: number) => {
      expiresAt = time;
    },
  };
}

it('reuses discovery and sequential calls, preserving SSH sessions, tabs or transactions', async () => {
  const f = await fixture();
  await f.agent.listTools();
  expect(f.stats()).toEqual({ starts: 1, calls: 0, disposed: 0 });
  await f.call('open-session');
  await f.agent.listTools();
  expect(await f.call('read-session-output')).toMatchObject({
    content: [{ text: 'stateful synthetic output' }],
  });
  expect(f.stats()).toEqual({ starts: 1, calls: 2, disposed: 0 });
  await f.close();
  expect(f.stats().disposed).toBe(1);
  expect(f.lifetimes[0]!.aborted).toBe(true);
  expect(f.leases.every((lease) => lease.every((b) => b === 0))).toBe(true);
});

it('isolates different connectors and different bridge/MCP sessions', async () => {
  const f = await fixture({}, 2),
    other = await fixture();
  await f.agent.listTools();
  await other.agent.listTools();
  await f.call('open-session');
  expect(await f.call('read-session-output', 'work', 1)).toMatchObject({
    content: [{ text: 'no session' }],
  });
  expect(await other.call('read-session-output')).toMatchObject({
    content: [{ text: 'no session' }],
  });
  expect(f.stats().starts).toBe(2);
  expect(other.stats().starts).toBe(1);
});

it('expires idle peers, resets the timer after use, and creates a fresh peer on demand', async () => {
  vi.useFakeTimers();
  const f = await fixture({ idleTimeoutMs: 100 });
  await f.agent.listTools();
  await vi.advanceTimersByTimeAsync(60);
  await f.call('open-session');
  await vi.advanceTimersByTimeAsync(60);
  expect(f.stats().disposed).toBe(0);
  await vi.advanceTimersByTimeAsync(40);
  expect(f.stats().disposed).toBe(1);
  expect(await f.call('read-session-output')).toMatchObject({
    content: [{ text: 'no session' }],
  });
  expect(f.stats().starts).toBe(2);
});

it('does not apply discovery/request deadlines to the cached connection lifetime', async () => {
  vi.useFakeTimers();
  const f = await fixture({ idleTimeoutMs: 60_000 });
  await f.agent.listTools();
  await f.call('open-session');
  await vi.advanceTimersByTimeAsync(21_000);
  expect(f.lifetimes[0]!.aborted).toBe(false);
  expect(await f.call('read-session-output')).toMatchObject({
    content: [{ text: 'stateful synthetic output' }],
  });
  expect(f.stats().starts).toBe(1);
});

it('serializes requests to one peer and does not idle-expire busy or queued work', async () => {
  vi.useFakeTimers();
  const f = await fixture({ idleTimeoutMs: 100 });
  await f.agent.listTools();
  f.hold.call = deferred();
  const first = f.call('open-session');
  await vi.advanceTimersByTimeAsync(0);
  const second = f.call('read-session-output');
  await vi.advanceTimersByTimeAsync(200);
  expect(f.stats()).toEqual({ starts: 1, calls: 1, disposed: 0 });
  f.hold.call.resolve();
  await first;
  expect(await second).toMatchObject({
    content: [{ text: 'stateful synthetic output' }],
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.stats().disposed).toBe(1);
});

it.each(['disable', 'remove', 'definition', 'approval', 'credential'])(
  'tears down a cached peer on %s changes without waiting for another call',
  async (change) => {
    const f = await fixture();
    await f.agent.listTools();
    const current = f.state.connectors[0]!;
    if (change === 'disable') current.enabled = false;
    if (change === 'remove') f.state.connectors = [];
    if (change === 'definition' && current.executionMode === 'native')
      current.arguments.push('--changed');
    if (change === 'approval') current.trustApproval = null;
    if (change === 'credential')
      current.secretBindings = { PROVIDER_TOKEN: 'missing-reference' };
    await f.bridge.refresh();
    expect(f.stats().disposed).toBe(1);
    expect(f.leases[0]!.every((b) => b === 0)).toBe(true);
    expect(await f.call('read-session-output')).toMatchObject({
      isError: true,
    });
    expect(f.stats().calls).toBe(0);
  },
);

it('revalidates credential metadata even when the definition/approval hash is unchanged', async () => {
  const f = await fixture();
  const value = f.state.connectors[0]!;
  value.secretBindings = { PROVIDER_TOKEN: 'wmh-secret-synthetic' };
  f.state.secretReferences.push({
    id: 'wmh-secret-synthetic',
    adapter: 'windows',
    present: true,
    ownerIds: [value.id],
  });
  value.trustApproval!.definitionHash = definitionHash(value);
  await f.agent.listTools();
  f.state.secretReferences[0]!.present = false;
  await f.bridge.refresh();
  expect(f.stats().disposed).toBe(1);
});

it('closes all peers when registry/recovery/agent-registration validation fails', async () => {
  const f = await fixture({}, 2);
  await f.agent.listTools();
  f.failRead();
  await expect(f.bridge.refresh()).rejects.toThrow(
    'The managed hub registry is unavailable.',
  );
  expect(f.stats().disposed).toBe(2);
  expect(JSON.stringify(await f.call('read-session-output'))).not.toContain(
    'SYNTHETIC_PRIVATE_REGISTRY',
  );
});

it('closes on upstream disconnect and reconnects only for a subsequent explicit request', async () => {
  const f = await fixture();
  await f.agent.listTools();
  await f.peers[0]!.client.close();
  await f.call('open-session');
  expect(f.stats()).toEqual({ starts: 2, calls: 1, disposed: 1 });
});

it('shares one replacement when concurrent callers wait for an old peer to finish closing', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.agent.listTools();
  f.hold.dispose = deferred();
  await f.peers[0]!.client.close();
  const first = f.call('open-session');
  const second = f.call('read-session-output');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stats().starts).toBe(1);
  f.hold.dispose.resolve();
  await first;
  expect(await second).toMatchObject({
    content: [{ text: 'stateful synthetic output' }],
  });
  expect(f.stats()).toEqual({ starts: 2, calls: 2, disposed: 1 });
});

it('never creates a replacement if shutdown starts while a caller waits for cleanup', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.agent.listTools();
  f.hold.dispose = deferred();
  await f.peers[0]!.client.close();
  const pending = f.call('open-session').catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const closing = f.bridge.close();
  f.hold.dispose.resolve();
  await closing;
  await pending;
  expect(f.stats()).toEqual({ starts: 1, calls: 0, disposed: 1 });
});

it('refuses credential echoes, clears the lease, and never retries an uncertain failed call', async () => {
  const f = await fixture();
  await f.agent.listTools();
  const result = await f.call('leak');
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_CREDENTIAL');
  expect(f.stats()).toEqual({ starts: 1, calls: 1, disposed: 1 });
  expect(f.leases[0]!.every((b) => b === 0)).toBe(true);
  await f.call('open-session');
  expect(f.stats().starts).toBe(2);
});

it('retains the peer after an ordinary tool-level error response', async () => {
  const f = await fixture();
  await f.agent.listTools();
  expect(await f.call('tool-error')).toMatchObject({ isError: true });
  await f.call('open-session');
  expect(f.stats()).toEqual({ starts: 1, calls: 2, disposed: 0 });
});

it('sanitizes provider exceptions and retires without replaying the call', async () => {
  const f = await fixture();
  await f.agent.listTools();
  const result = await f.call('fail');
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_PROVIDER');
  expect(f.stats()).toEqual({ starts: 1, calls: 1, disposed: 1 });
});

it('cancels a request without retaining an uncertain session or replaying it', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.agent.listTools();
  f.hold.call = deferred();
  const controller = new AbortController();
  const call = f.agent.callTool(
    { name: 'connector-0__open-session' },
    undefined,
    { signal: controller.signal },
  );
  const rejected = expect(call).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stats().calls).toBe(1);
  controller.abort();
  await rejected;
  f.hold.call.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stats()).toEqual({ starts: 1, calls: 1, disposed: 1 });
  expect(f.leases[0]!.every((b) => b === 0)).toBe(true);
});

it('tears down expired credentials and enforces a hard peer lifetime', async () => {
  vi.useFakeTimers();
  const f = await fixture({ idleTimeoutMs: 1000, maxLifetimeMs: 100 });
  f.expires(Date.now() + 50);
  await f.agent.listTools();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.stats().disposed).toBe(1);
  f.expires(Date.now() + 10_000);
  await f.call('open-session');
  await vi.advanceTimersByTimeAsync(100);
  expect(f.stats().disposed).toBe(2);
});

it('bounds the cache without starting excess peers', async () => {
  const f = await fixture({ maxPeers: 1 }, 2);
  expect((await f.agent.listTools()).tools).toHaveLength(5);
  expect(f.stats().starts).toBe(1);
});

it('awaits late-starting peers on shutdown and disposes them exactly once', async () => {
  const f = await fixture();
  f.hold.startup = deferred();
  const listing = f.agent.listTools().catch(() => undefined);
  // Let the SDK dispatch and connection factory enter startup.
  for (let i = 0; i < 20 && !f.stats().starts; i++) await Promise.resolve();
  const closing = f.bridge.close();
  f.hold.startup.resolve();
  await closing;
  await listing;
  expect(f.stats().disposed).toBe(1);
  expect(f.lifetimes[0]!.aborted).toBe(true);
});
