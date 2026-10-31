import { describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
  CancelledNotificationSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { RuntimeFault } from '../packages/hub-core/src/runtime/capabilities.js';
import { definitionHash } from '@waleed/hub-core';
import type { Connector, HubState } from '@waleed/contracts';
import {
  createAgentBridge,
  remoteSessionPeer,
  type AgentBridgeServer,
  type BridgeConnect,
  type BridgeSession,
  type BridgeSnapshot,
} from '../packages/hub-core/src/integrations/bridge.js';
import { profileState } from './helpers/runtime.js';
import { mcpSessionFixture } from './helpers/mcp-session-http.js';

const connectorUnavailable =
  'The connector is unavailable, changed, disabled, or requires authentication. Inspect the hub and refresh tools.';
const registryUnavailable =
  'The managed hub registry is unavailable. Inspect local recovery.';
const refreshTools = 'Refresh the hub tool list before using this tool.';

// The pool never reads a real clock: every timer is listed and fired by hand.
class FakeClock {
  private current = 1_700_000_000_000;
  private next = 1;
  readonly timers = new Map<
    number,
    { at: number; delay: number; callback: () => void }
  >();

  readonly now = () => this.current;
  readonly setTimer = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.current + ms, delay: ms, callback });
    return id;
  };
  readonly clearTimer = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  advance(ms: number, skip?: (delay: number) => boolean) {
    const target = this.current + ms;
    for (;;) {
      let due: { at: number; delay: number; callback: () => void } | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at > target) continue;
        if (skip?.(timer.delay)) continue;
        if (!due || timer.at < due.at) due = timer;
      }
      if (!due) break;
      for (const [id, timer] of this.timers)
        if (timer === due) this.timers.delete(id);
      this.current = due.at;
      due.callback();
    }
    this.current = target;
  }
}

interface FakeSession extends BridgeSession {
  reads: number;
  verifications: number;
}

function createFakeSession(options: {
  clock: FakeClock;
  state: HubState;
  bootId: () => string;
  // A read fails; 'pending' fails it on a ledger whose only open entry is a
  // prepared mutation.
  fail?: (read: number) => boolean | 'pending';
}): FakeSession {
  let seq = 0;
  let tail: Promise<void> = Promise.resolve();
  const session: FakeSession = {
    reads: 0,
    verifications: 0,
    async snapshot(inside) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        session.reads += 1;
        const failure = options.fail?.(session.reads);
        if (failure) {
          seq += 1;
          inside?.({
            seq,
            failed: true,
            ...(failure === 'pending' ? { pending: true } : {}),
          });
          throw new Error('synthetic registry failure');
        }
        seq += 1;
        const snapshot: BridgeSnapshot = {
          seq,
          state: structuredClone(options.state),
          bootId: options.bootId(),
        };
        inside?.(snapshot);
        return snapshot;
      } finally {
        release();
      }
    },
    async verify() {
      session.verifications += 1;
    },
    now: options.clock.now,
    setTimer: options.clock.setTimer,
    clearTimer: options.clock.clearTimer,
  };
  return session;
}

interface PeerConfig {
  // How many tools/list pages the peer serves.
  pages?: number;
  // Called before every page is answered.
  onPage?: (page: number) => void;
  // Called before every tools/call is answered.
  onCall?: (name: string) => Promise<void> | void;
  // The output schema of every tool; the result never satisfies it.
  outputSchema?: Record<string, unknown>;
}

interface PeerHandle {
  server: Server;
  client: Client;
  lists: number[];
  calls: string[];
  cancelled: (string | number | undefined)[];
  begins: number;
  ends: number;
  disposed: number;
  dispose(): Promise<void>;
}

async function createPeer(config: PeerConfig = {}): Promise<PeerHandle> {
  const lists: number[] = [];
  const calls: string[] = [];
  const cancelled: (string | number | undefined)[] = [];
  const server = new Server(
    { name: 'synthetic-peer', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
    cancelled.push(notification.params.requestId);
  });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const page = typeof cursor === 'string' ? Number(cursor) : 0;
    lists.push(page);
    config.onPage?.(page);
    const tools = [
      {
        name: `tool-${page}`,
        inputSchema: { type: 'object' as const },
        ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
      },
    ];
    const next = page + 1 < (config.pages ?? 1) ? String(page + 1) : undefined;
    return { tools, ...(next ? { nextCursor: next } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    await config.onCall?.(request.params.name);
    return { content: [{ type: 'text' as const, text: 'synthetic success' }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client(
    { name: 'synthetic-peer-client', version: '1' },
    { capabilities: {} },
  );
  await client.connect(b);
  return {
    server,
    client,
    lists,
    calls,
    cancelled,
    begins: 0,
    ends: 0,
    disposed: 0,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

interface HarnessConfig {
  state?: HubState;
  peer?: PeerConfig;
  clock?: FakeClock;
  bootId?: () => string;
  fail?: (read: number) => boolean | 'pending';
  notAfter?: (now: number) => number;
  // The connector whose peer disposal never settles on its own.
  hangDispose?: string;
  // The remote session of a remote connector: the peer is a real HTTP
  // session against the local fixture.
  remote?: { origin: string };
}

interface Harness {
  clock: FakeClock;
  session: FakeSession;
  state: HubState;
  bridge: AgentBridgeServer;
  agent: Client;
  connects: string[];
  peers: PeerHandle[];
}

async function createHarness(config: HarnessConfig = {}): Promise<Harness> {
  const clock = config.clock ?? new FakeClock();
  const state = config.state ?? profileState(['native']);
  const session = createFakeSession({
    clock,
    state,
    bootId: config.bootId ?? (() => 'boot-1'),
    ...(config.fail ? { fail: config.fail } : {}),
  });
  const connects: string[] = [];
  const peers: PeerHandle[] = [];
  const connect: BridgeConnect = async (connector, signal, died) => {
    connects.push(connector.id);
    // A remote peer is a real HTTP session against the local fixture. It is
    // the production remote peer, built as the bridge builds it.
    if (config.remote)
      return remoteSessionPeer(
        new Client(
          { name: 'synthetic-remote-client', version: '1' },
          { capabilities: {} },
        ),
        connector as Extract<Connector, { executionMode: 'remote' }>,
        signal,
        died ?? (() => undefined),
        undefined,
        config.remote.origin,
      );
    const hang = config.hangDispose === connector.id;
    const handle = await createPeer(config.peer);
    peers.push(handle);
    return {
      client: handle.client,
      async dispose() {
        handle.disposed += 1;
        if (hang) await new Promise<void>(() => undefined);
        await handle.dispose();
      },
      assertPublic() {},
      beginOperation() {
        handle.begins += 1;
      },
      endOperation() {
        handle.ends += 1;
      },
      ...(config.notAfter ? { notAfter: config.notAfter(clock.now()) } : {}),
    };
  };
  const bridge = createAgentBridge(
    async () => structuredClone(state),
    connect,
    session,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'synthetic-agent', version: '1' },
    { capabilities: {} },
  );
  await agent.connect(b);
  return { clock, session, state, bridge, agent, connects, peers };
}

// The connector of the synthetic profile.
const connectorOf = (state: HubState, id = 'connector-0') =>
  state.connectors.find((item) => item.id === id) as Extract<
    Connector,
    { executionMode: 'native' }
  >;
// A changed definition needs a fresh approval.
const reapprove = (connector: Connector) => {
  connector.revision += 1;
  connector.trustApproval = {
    revision: connector.revision,
    approvedAt: connector.createdAt,
    definitionHash: definitionHash(connector),
    risk: 'native_execution',
  };
};
// The connector of a managed package: the bridge verifies it once per
// operation.
const asManagedPackage = (state: HubState, id = 'connector-0') => {
  const connector = connectorOf(state, id);
  connector.package = {
    ecosystem: 'npm',
    name: 'synthetic/package',
    version: '1.0.0',
    entry: 'server',
    entryPath: 'index.js',
    installId: '00000000-0000-4000-8000-000000000000',
    integrity: `sha512-${'A'.repeat(86)}==`,
    lockHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
  };
  reapprove(connector);
  return connector;
};
// The connector owns one credential reference.
const withCredential = (state: HubState, id = 'connector-0') => {
  const connector = connectorOf(state, id);
  connector.secretBindings = { SAMPLE_BINDING: 'reference-a' };
  state.secretReferences.push({
    id: 'reference-a',
    adapter: 'windows',
    present: true,
    ownerIds: [connector.id],
    kind: 'oauth',
  });
  reapprove(connector);
  return connector;
};
const disable = (state: HubState, id = 'connector-0') => {
  const connector = connectorOf(state, id);
  connector.enabled = false;
  connector.trustApproval = null;
};
const wait = (ms = 20) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Polls an observable condition until it holds or the timeout passes. The
// tests wait for what they observe, never for a guessed duration.
async function until(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline)
      throw new Error('The condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('agent bridge session mode', () => {
  it('serves three calls over one native peer', async () => {
    const harness = await createHarness();
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      const name = tools.tools[0]!.name;
      for (let index = 0; index < 3; index++)
        expect(
          await harness.agent.callTool({ name, arguments: {} }),
        ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(1);
      expect(harness.peers).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(0);
      // Every operation opens and closes its own window.
      expect(harness.peers[0]?.begins).toBe(4);
      expect(harness.peers[0]?.ends).toBe(4);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 6: the deadline of a finished request leaves the peer alive and reusable', async () => {
    const harness = await createHarness();
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The operation deadline of the finished call passes.
      harness.clock.advance(120_000);
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 7: a call that times out after dispatch invalidates the peer without a replay', async () => {
    let calls = 0;
    const harness = await createHarness({
      peer: {
        onCall: async () => {
          calls += 1;
          if (calls === 1) await new Promise<void>(() => undefined);
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const pending = harness.agent.callTool({ name, arguments: {} });
      await wait();
      // The operation deadline of the call passes while it is in flight.
      harness.clock.advance(60_001);
      expect(await pending).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.calls).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(1);
      // The next call starts a fresh peer: the timed out one is never reused.
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 8: a connector disabled while a request is queued refuses the queued request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createHarness({
      peer: {
        onCall: async () => {
          await gate;
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const first = harness.agent.callTool({ name, arguments: {} });
      await wait();
      const queued = harness.agent.callTool({ name, arguments: {} });
      await wait();
      // The connector is disabled while the second request waits.
      disable(harness.state);
      release();
      expect(await first).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      expect(await queued).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.disposed).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 10: a connector disabled between two list pages drops it from the list', async () => {
    const state = profileState(['native']);
    const harness = await createHarness({
      state,
      peer: {
        pages: 3,
        onPage: (page) => {
          if (page === 0) disable(state);
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(0);
      expect(harness.peers[0]?.lists).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 12: an expiring lease invalidates the peer without a registry change', async () => {
    let now = 1_700_000_000_000;
    const harness = await createHarness({
      notAfter: () => now + 120_000,
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The lease ends in thirty seconds: the peer is invalidated.
      now += 90_001;
      harness.clock.advance(90_001);
      await wait();
      expect(harness.peers[0]?.disposed).toBe(1);
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 16: a new boot id closes the idle peers and the next request is fresh', async () => {
    let bootId = 'boot-1';
    const harness = await createHarness({ bootId: () => bootId });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      bootId = 'boot-2';
      await harness.bridge.reconcile();
      expect(harness.peers[0]?.disposed).toBe(1);
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 17: the max age reached while busy lets the call finish and retires the peer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createHarness({
      peer: {
        onCall: async () => {
          await gate;
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const pending = harness.agent.callTool({ name, arguments: {} });
      await wait();
      // The maximum session life passes while the call is in flight. The
      // deadline of the call is withheld so that the retirement is the only
      // thing under test.
      harness.clock.advance(3_600_000, (delay) => delay === 60_000);
      release();
      expect(await pending).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      await wait();
      expect(harness.peers[0]?.disposed).toBe(1);
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 25: the deadline of a finished request never cancels a later operation', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createHarness({
      peer: {
        onCall: async () => {
          calls += 1;
          if (calls === 2) await gate;
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const first = new AbortController();
      expect(
        await harness.agent.callTool({ name, arguments: {} }, undefined, {
          signal: first.signal,
        }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The finished call left no deadline behind.
      expect(
        [...harness.clock.timers.values()].some(
          (timer) => timer.delay === 60_000,
        ),
      ).toBe(false);
      // Half the first call's deadline later, a second call is in flight.
      harness.clock.advance(30_000);
      const second = harness.agent.callTool({ name, arguments: {} });
      await wait();
      expect(harness.peers[0]?.calls).toHaveLength(2);
      // The first call's deadline passes and its agent-side signal aborts
      // while the second is in flight: neither may reach the second.
      harness.clock.advance(30_001);
      first.abort();
      await wait();
      release();
      expect(await second).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      expect(harness.peers[0]?.cancelled).toHaveLength(0);
      expect(harness.peers[0]?.disposed).toBe(0);
      expect(harness.connects).toHaveLength(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 28: a new boot id is replaced inside the request instead of refused', async () => {
    let bootId = 'boot-1';
    const harness = await createHarness({ bootId: () => bootId });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The hub restarted and the watcher has not reconciled yet.
      bootId = 'boot-2';
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
      expect(harness.peers[0]?.disposed).toBe(1);
      // The replacement's request ran inside its own operation window.
      expect(harness.peers[1]?.begins).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 31: a peer tool list change reaches the agent once and refreshes nothing', async () => {
    const harness = await createHarness();
    try {
      let changes = 0;
      harness.agent.setNotificationHandler(
        ToolListChangedNotificationSchema,
        () => {
          changes += 1;
        },
      );
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      await harness.peers[0]!.server.notification({
        method: 'notifications/tools/list_changed',
      });
      await wait();
      expect(changes).toBe(1);
      // The bridge never refreshes the tool list of the peer itself.
      expect(harness.peers[0]?.lists).toHaveLength(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 32: a first page tool of a multi page listing is called through', async () => {
    const harness = await createHarness({
      peer: {
        pages: 3,
        outputSchema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(3);
      const first = tools.tools[0]!.name;
      // The result does not satisfy the output schema of the tool: the bridge
      // passes it through instead of validating it.
      const result = await harness.agent.request(
        { method: 'tools/call', params: { name: first, arguments: {} } },
        CallToolResultSchema,
      );
      expect(result).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      expect(harness.peers[0]?.calls).toEqual(['tool-0']);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 33: the max age refuses the request by clock and the next one is fresh', async () => {
    const harness = await createHarness();
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The clock crosses the maximum session life; the retirement timer is
      // withheld.
      harness.clock.advance(
        3_600_001,
        (delay) => delay === 300_000 || delay === 3_600_000,
      );
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 35: an eight page listing of a package connector verifies it once', async () => {
    const state = profileState(['native']);
    asManagedPackage(state);
    const harness = await createHarness({ state, peer: { pages: 8 } });
    try {
      await harness.agent.listTools();
      // The reused peer is verified once for the whole operation, not once per
      // page.
      const reads = harness.session.reads;
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(8);
      expect(harness.session.verifications).toBe(1);
      // The state is checked before every page.
      expect(harness.session.reads - reads).toBeGreaterThanOrEqual(8);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('row 37: the max age between two pages keeps the remaining pages served', async () => {
    const clock = new FakeClock();
    const harness = await createHarness({
      clock,
      peer: {
        pages: 4,
        onPage: (page) => {
          if (page !== 1) return;
          // The maximum session life passes between two pages. The deadline of
          // the listing is withheld so that the remaining pages are the only
          // thing under test.
          clock.advance(3_600_000, (delay) => delay === 20_000);
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(4);
      expect(harness.peers[0]?.lists).toHaveLength(4);
      await wait();
      // The entry is retired after the listing.
      expect(harness.peers[0]?.disposed).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('refuses a disabled connector and disposes its peer', async () => {
    const harness = await createHarness();
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      disable(harness.state);
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      await wait();
      expect(harness.peers[0]?.disposed).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('refuses a tool the agent never listed', async () => {
    const harness = await createHarness();
    try {
      expect(
        await harness.agent.callTool({ name: 'connector-0__unknown' }),
      ).toMatchObject({ isError: true, content: [{ text: refreshTools }] });
      expect(harness.connects).toHaveLength(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('invalidates the peer when the credential stamp changes', async () => {
    const state = profileState(['native']);
    withCredential(state);
    const harness = await createHarness({ state });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The credential reference changed: the stamp is different.
      const reference = harness.state.secretReferences[0]!;
      reference.present = false;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.disposed).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('reports an unavailable registry and leaves no peer', async () => {
    let failFrom = Number.POSITIVE_INFINITY;
    const harness = await createHarness({
      fail: (read) => read >= failFrom,
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      // The route is read, then the dispatch validation reads the registry
      // again: that read fails.
      failFrom = harness.session.reads + 2;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: registryUnavailable }],
      });
      expect(harness.peers[0]?.disposed).toBe(1);
      expect(harness.connects).toHaveLength(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('fails the listing closed when the registry is unavailable', async () => {
    const harness = await createHarness({ fail: () => true });
    try {
      await expect(harness.agent.listTools()).rejects.toThrow(
        'The managed hub registry is unavailable.',
      );
      expect(harness.connects).toHaveLength(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('reconciles each generation against its own stamps', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createHarness({
      peer: {
        onCall: async () => {
          calls += 1;
          if (calls === 1) await gate;
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const pending = harness.agent.callTool({ name, arguments: {} });
      await wait();
      // The max age retires the busy first generation; the call deadlines are
      // left alone.
      harness.clock.advance(3_600_000, (delay) => delay === 60_000);
      // The definition changes and is approved again; a listing starts the
      // second generation with the new definition.
      const connector = connectorOf(harness.state);
      connector.environmentLiterals = { MODE: 'changed' };
      reapprove(connector);
      await harness.agent.listTools();
      expect(harness.connects).toHaveLength(2);
      await harness.bridge.reconcile();
      release();
      // The first generation carries the old definition: its result never
      // reaches the agent.
      expect(await pending).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.disposed).toBe(1);
      expect(harness.peers[1]?.disposed).toBe(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('refuses a stale tool on a peer of a newer definition', async () => {
    const harness = await createHarness();
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // A second agent client would list the new definition; this one still
      // holds the tool of the old one.
      const connector = connectorOf(harness.state);
      connector.environmentLiterals = { MODE: 'changed' };
      reapprove(connector);
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ isError: true, content: [{ text: refreshTools }] });
      expect(harness.peers[0]?.calls).toHaveLength(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('invalidates a busy peer whose connector is disabled across a hub restart', async () => {
    let bootId = 'boot-1';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const harness = await createHarness({
      bootId: () => bootId,
      peer: {
        onCall: async () => {
          calls += 1;
          if (calls === 1) await gate;
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const pending = harness.agent.callTool({ name, arguments: {} });
      await wait();
      // The hub restarted and the connector was disabled: revocation wins
      // over the graceful retirement of the old boot.
      bootId = 'boot-2';
      disable(harness.state);
      await harness.bridge.reconcile();
      release();
      expect(await pending).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.disposed).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('authorises every startup from a fresh snapshot', async () => {
    const state = profileState(['native', 'native']);
    const harness = await createHarness({
      state,
    });
    const snapshot = harness.session.snapshot.bind(harness.session);
    let reads = 0;
    harness.session.snapshot = async (inside) => {
      // The first listing snapshot approved both peers. Revoke the second
      // before its fresh startup admission, independently of listing order.
      if (++reads === 3) disable(state, 'connector-1');
      return snapshot(inside);
    };
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      // The second connector never resolved a credential or launched.
      expect(harness.connects).toEqual(['connector-0']);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('omits a concurrent peer revoked while another catalog is being answered', async () => {
    const state = profileState(['native', 'native']);
    const harness = await createHarness({
      state,
      peer: { onPage: () => disable(state, 'connector-1') },
    });
    try {
      expect((await harness.agent.listTools()).tools).toHaveLength(1);
      // Both admissions happened before revocation; the later response must
      // not advertise the peer whose approval has since been withdrawn.
      expect(harness.connects).toEqual(['connector-0', 'connector-1']);
      await harness.bridge.reconcile();
      expect(harness.peers[1]?.disposed).toBe(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('closes a reused peer whose package fails verification', async () => {
    const state = profileState(['native']);
    asManagedPackage(state);
    const harness = await createHarness({ state });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      harness.session.verify = async () => {
        throw new RuntimeFault('package_modified');
      };
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.calls).toHaveLength(0);
      expect(harness.peers[0]?.disposed).toBe(1);
      // The package is restored: the next call starts a fresh process.
      harness.session.verify = async () => undefined;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('closes a peer whose result fails its schema', async () => {
    const harness = await createHarness();
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      // The next tools/call answer is malformed on the wire: the bridge's
      // client rejects it against the result schema.
      const transport = harness.peers[0]!.server.transport!;
      const send = transport.send.bind(transport);
      let malformed = true;
      transport.send = (message, options) => {
        if (malformed && 'result' in message && 'content' in message.result) {
          malformed = false;
          return send(
            { ...message, result: { content: 'malformed' } },
            options,
          );
        }
        return send(message, options);
      };
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.disposed).toBe(1);
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('keeps a peer that answered a JSON-RPC error', async () => {
    let calls = 0;
    const harness = await createHarness({
      peer: {
        onCall: () => {
          if (++calls === 1)
            throw new McpError(ErrorCode.InvalidParams, 'synthetic refusal');
        },
      },
    });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const refused = await harness.agent.callTool({ name, arguments: {} });
      expect(refused).toMatchObject({ isError: true });
      expect(JSON.stringify(refused)).not.toContain('synthetic refusal');
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('admits no request and launches no peer once closing starts', async () => {
    const harness = await createHarness({
      state: profileState(['native', 'remote']),
      hangDispose: 'connector-0',
    });
    try {
      await harness.agent.listTools();
      expect(harness.connects).toHaveLength(2);
      // The pooled disposal hangs: the bridge stays open until its deadline.
      const closing = harness.bridge.close();
      await wait();
      await expect(harness.agent.listTools()).rejects.toThrow();
      expect(harness.connects).toHaveLength(2);
      harness.clock.advance(5_000);
      await closing;
    } finally {
      await harness.agent.close();
    }
  });

  it('cancels the pending tool list notification on close', async () => {
    const harness = await createHarness();
    try {
      await harness.agent.listTools();
      for (let index = 0; index < 2; index++)
        await harness.peers[0]!.server.notification({
          method: 'notifications/tools/list_changed',
        });
      await wait();
      expect(
        [...harness.clock.timers.values()].some((timer) => timer.delay <= 1000),
      ).toBe(true);
      await harness.bridge.close();
      expect(
        [...harness.clock.timers.values()].some((timer) => timer.delay <= 1000),
      ).toBe(false);
    } finally {
      await harness.agent.close();
    }
  });

  it('pools a remote connector across requests', async () => {
    const harness = await createHarness({ state: profileState(['remote']) });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The listing and the two calls share one pooled peer.
      expect(harness.connects).toHaveLength(1);
      expect(harness.peers).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('serves a fresh peer after the remote session was refused', async () => {
    const fixture = await mcpSessionFixture();
    const state = profileState(['remote']);
    const connector = state.connectors[0] as Extract<
      Connector,
      { executionMode: 'remote' }
    >;
    connector.endpoint = `${fixture.origin}/mcp`;
    reapprove(connector);
    const harness = await createHarness({
      state,
      remote: { origin: fixture.origin },
    });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      const name = tools.tools[0]!.name;
      const initializes = () =>
        fixture.seen.filter(
          (event) => event.messages[0]?.method === 'initialize',
        ).length;
      expect(initializes()).toBe(1);
      // The session is refused: the peer is dead and the request fails.
      fixture.options.notFound = true;
      fixture.refusals = 1;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      // The next request starts a fresh peer: a new initialize.
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(initializes()).toBe(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
      await fixture.close();
    }
  });

  it('retires a remote peer whose call was cancelled', async () => {
    const fixture = await mcpSessionFixture();
    const state = profileState(['remote']);
    const connector = state.connectors[0] as Extract<
      Connector,
      { executionMode: 'remote' }
    >;
    connector.endpoint = `${fixture.origin}/mcp`;
    reapprove(connector);
    const harness = await createHarness({
      state,
      remote: { origin: fixture.origin },
    });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      const name = tools.tools[0]!.name;
      const initializes = () =>
        fixture.seen.filter(
          (event) => event.messages[0]?.method === 'initialize',
        ).length;
      expect(initializes()).toBe(1);
      // The call of the agent reaches the peer and is never answered.
      const answer = fixture.handler;
      fixture.handler = (event) => {
        if (event.messages[0]?.method === 'tools/call') return;
        answer(event);
      };
      const controller = new AbortController();
      const pending = harness.agent.callTool(
        { name, arguments: {} },
        CallToolResultSchema,
        { signal: controller.signal },
      );
      await until(() =>
        fixture.seen.some(
          (event) => event.messages[0]?.method === 'tools/call',
        ),
      );
      // The agent cancels the call: the peer that served it is retired.
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      // The next call is served by a fresh peer: a new initialize.
      fixture.handler = answer;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(initializes()).toBe(2);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
      await fixture.close();
    }
  });

  it('pools a docker connector across requests', async () => {
    const harness = await createHarness({ state: profileState(['docker']) });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      // The listing and the two calls share one pooled peer.
      expect(harness.connects).toHaveLength(1);
      expect(harness.peers).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
    // The pooled peer is disposed once, when the bridge closes.
    expect(harness.peers[0]?.disposed).toBe(1);
  });

  it('keeps a reused peer whose operation was cancelled during package verification', async () => {
    const state = profileState(['native']);
    asManagedPackage(state);
    const harness = await createHarness({ state });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const controller = new AbortController();
      // The agent cancels while the reused package is verified: no request
      // has reached the peer yet.
      harness.session.verify = async (_connector, signal) => {
        controller.abort();
        await until(() => signal.aborted);
        throw new RuntimeFault('cancelled');
      };
      await expect(
        harness.agent.callTool({ name, arguments: {} }, CallToolResultSchema, {
          signal: controller.signal,
        }),
      ).rejects.toBeDefined();
      await wait();
      expect(harness.peers[0]?.calls).toHaveLength(0);
      expect(harness.peers[0]?.disposed).toBe(0);
      // The same peer serves the next call.
      harness.session.verify = async () => undefined;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('closes a reused peer whose package fails verification while the call is cancelled', async () => {
    const state = profileState(['native']);
    asManagedPackage(state);
    const harness = await createHarness({ state });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      const controller = new AbortController();
      // The package is modified: a cancellation at the same time never
      // hides it.
      harness.session.verify = async (_connector, signal) => {
        controller.abort();
        await until(() => signal.aborted);
        throw new RuntimeFault('package_modified');
      };
      await expect(
        harness.agent.callTool({ name, arguments: {} }, CallToolResultSchema, {
          signal: controller.signal,
        }),
      ).rejects.toBeDefined();
      await until(() => harness.peers[0]?.disposed === 1);
      expect(harness.peers[0]?.calls).toHaveLength(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('refuses a call whose lease would end before the call deadline', async () => {
    const harness = await createHarness({
      // Eighty seconds: enough for a listing, not for a sixty second call
      // plus the thirty second margin.
      notAfter: (now) => now + 80_000,
    });
    try {
      const tools = await harness.agent.listTools();
      expect(tools.tools).toHaveLength(1);
      const name = tools.tools[0]!.name;
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect(harness.peers[0]?.calls).toHaveLength(0);
      // The refusal keeps the healthy peer: a second call is refused the
      // same way without a replacement launch, and a listing still uses it.
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: connectorUnavailable }],
      });
      expect((await harness.agent.listTools()).tools).toHaveLength(1);
      expect(harness.connects).toHaveLength(1);
      expect(harness.peers[0]?.disposed).toBe(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('closes a pooled peer older than the registry instead of keeping it for later listings', async () => {
    const harness = await createHarness();
    try {
      expect((await harness.agent.listTools()).tools).toHaveLength(1);
      // The definition changes before any reconciliation ran: the pooled
      // peer still carries the old one.
      const connector = connectorOf(harness.state);
      connector.environmentLiterals = { MODE: 'changed' };
      reapprove(connector);
      await harness.agent.listTools();
      await until(() => harness.peers[0]?.disposed === 1);
      expect(harness.peers[0]?.lists).toHaveLength(1);
      // The next listing starts a peer of the new definition.
      expect((await harness.agent.listTools()).tools).toHaveLength(1);
      expect(harness.connects).toHaveLength(2);
      expect(harness.peers[1]?.disposed).toBe(0);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });

  it('defers the reconciliation of a prepared mutation and still fails a needs-review ledger closed', async () => {
    let failure: boolean | 'pending' = false;
    const harness = await createHarness({ fail: () => failure });
    try {
      const tools = await harness.agent.listTools();
      const name = tools.tools[0]!.name;
      // An unrelated mutation is prepared: the idle peer stays.
      failure = 'pending';
      await harness.bridge.reconcile();
      await wait();
      expect(harness.peers[0]?.disposed).toBe(0);
      // No request is dispatched while the ledger is blocked.
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ text: registryUnavailable }],
      });
      expect(harness.peers[0]?.calls).toHaveLength(0);
      // The mutation committed: the peer serves again.
      failure = false;
      await harness.bridge.reconcile();
      expect(
        await harness.agent.callTool({ name, arguments: {} }),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      expect(harness.connects).toHaveLength(1);
      // A ledger that needs review closes every idle peer.
      failure = true;
      await harness.bridge.reconcile();
      await until(() => harness.peers[0]?.disposed === 1);
    } finally {
      await harness.agent.close();
      await harness.bridge.close();
    }
  });
});
