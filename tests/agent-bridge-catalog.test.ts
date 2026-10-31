// Incident 2026-10-31: Claude Code timed out fetching the hub's tools
// because the first tools/list waited for every managed peer to verify and
// start. A bridge with a catalog answers from the last discovered tools and
// refreshes them in the background.
import { afterEach, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { definitionHash } from '@waleed/hub-core';
import type { HubState } from '@waleed/contracts';
import {
  createAgentBridge,
  type BridgeConnect,
  type BridgeSession,
} from '../packages/hub-core/src/integrations/bridge.js';
import {
  parseToolCatalog,
  serializeToolCatalog,
  type ToolCatalog,
} from '../packages/hub-core/src/integrations/tool-catalog.js';
import { profileState } from './helpers/runtime.js';

const tool = (name: string): Tool => ({
  name,
  inputSchema: { type: 'object' },
});

interface Harness {
  agent: Client;
  stored: { catalog: ToolCatalog | undefined };
  connects: string[];
  timers: Map<number, { ms: number; callback: () => void }>;
  changed: () => number;
  close(): Promise<void>;
}

// Each connector's peer lists the tools `listing` names for it right now;
// `gate` holds every peer listing until it is opened.
async function createHarness(options: {
  state: HubState;
  catalog?: ToolCatalog;
  listing: (connectorId: string) => Tool[] | Error;
  gate?: Promise<void>;
}): Promise<Harness> {
  const stored = { catalog: options.catalog };
  const connects: string[] = [];
  const timers = new Map<number, { ms: number; callback: () => void }>();
  let nextTimer = 1;
  let seq = 0;
  const session: BridgeSession = {
    async snapshot(inside) {
      const snapshot = {
        seq: ++seq,
        state: structuredClone(options.state),
        bootId: 'boot-1',
      };
      inside?.(snapshot);
      return snapshot;
    },
    async verify() {},
    now: () => 1_700_000_000_000,
    setTimer(callback, ms) {
      const id = nextTimer++;
      timers.set(id, { ms, callback });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    catalog: {
      read: async () => stored.catalog && new Map(stored.catalog),
      write: async (catalog) => {
        stored.catalog = new Map(catalog);
      },
    },
  };
  const peers: Array<() => Promise<void>> = [];
  const connect: BridgeConnect = async (connector) => {
    connects.push(connector.id);
    const listed = options.listing(connector.id);
    if (listed instanceof Error) throw listed;
    const peer = new Server(
      { name: 'catalog-peer', version: '1' },
      { capabilities: { tools: {} } },
    );
    peer.setRequestHandler(ListToolsRequestSchema, async () => {
      await options.gate;
      return { tools: options.listing(connector.id) as Tool[] };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await peer.connect(a);
    const client = new Client({ name: 'catalog-peer-client', version: '1' });
    await client.connect(b);
    const dispose = async () => {
      await client.close();
      await peer.close();
    };
    peers.push(dispose);
    return { client, assertPublic() {}, dispose };
  };
  const bridge = createAgentBridge(
    async () => structuredClone(options.state),
    connect,
    session,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client({ name: 'catalog-agent', version: '1' });
  let changes = 0;
  agent.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes++;
  });
  await agent.connect(b);
  return {
    agent,
    stored,
    connects,
    timers,
    changed: () => changes,
    async close() {
      await agent.close();
      await bridge.close();
      await Promise.all(peers.map((dispose) => dispose()));
    },
  };
}

const entryFor = (state: HubState, id: string, tools: Tool[]) => ({
  hash: definitionHash(state.connectors.find((item) => item.id === id)!),
  tools,
});
const names = async (agent: Client) =>
  (await agent.listTools()).tools.map((item) => item.name);

let open: Harness | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

it('answers from the stored catalog while peers are still starting, then announces the refreshed tools', async () => {
  const state = profileState(['native']);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  open = await createHarness({
    state,
    catalog: new Map([
      ['connector-0', entryFor(state, 'connector-0', [tool('old')])],
    ]),
    listing: () => [tool('new')],
    gate,
  });
  const cached = await names(open.agent);
  expect(cached).toHaveLength(1);
  expect(cached[0]).toMatch(/old$/);
  release();
  await expect.poll(() => open!.changed()).toBe(1);
  expect(open.stored.catalog?.get('connector-0')?.tools).toEqual([tool('new')]);
  expect((await names(open.agent))[0]).toMatch(/new$/);
});

it('never serves a cached connector whose definition changed or that was disabled', async () => {
  const state = profileState(['native', 'native']);
  state.connectors[1]!.enabled = false;
  open = await createHarness({
    state,
    catalog: new Map([
      ['connector-0', { hash: 'f'.repeat(64), tools: [tool('stale')] }],
      ['connector-1', entryFor(state, 'connector-1', [tool('disabled')])],
    ]),
    listing: () => [tool('live')],
  });
  const listed = await names(open.agent);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatch(/live$/);
  expect(open.connects).toEqual(['connector-0']);
});

it('keeps the cached tools of a connector that cannot list and retries the listing', async () => {
  const state = profileState(['native', 'native']);
  let failing = true;
  open = await createHarness({
    state,
    catalog: new Map([
      ['connector-0', entryFor(state, 'connector-0', [tool('first')])],
      ['connector-1', entryFor(state, 'connector-1', [tool('second')])],
    ]),
    listing: (id) =>
      id === 'connector-1' && failing
        ? new Error('synthetic startup failure')
        : [tool(id === 'connector-0' ? 'first' : 'second')],
  });
  expect(await names(open.agent)).toHaveLength(2);
  await expect
    .poll(() => [...open!.timers.values()].some((timer) => timer.ms === 10_000))
    .toBe(true);
  expect(open.stored.catalog?.get('connector-1')?.tools).toEqual([
    tool('second'),
  ]);
  // The refreshed listing still advertises both connectors: nothing changed.
  expect(open.changed()).toBe(0);
  failing = false;
  const retry = [...open.timers.entries()].find(([, t]) => t.ms === 10_000)!;
  open.timers.delete(retry[0]);
  const attempts = open.connects.filter((id) => id === 'connector-1').length;
  retry[1].callback();
  await expect
    .poll(() => open!.connects.filter((id) => id === 'connector-1').length)
    .toBeGreaterThan(attempts);
});

it('fills the catalog even when the agent gives up on its first listing', async () => {
  const state = profileState(['native']);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  open = await createHarness({ state, listing: () => [tool('read')], gate });
  await expect(
    open.agent.listTools(undefined, { timeout: 50 }),
  ).rejects.toThrow();
  release();
  await expect.poll(() => open!.stored.catalog?.size).toBe(1);
  const connectsBefore = open.connects.length;
  expect((await names(open.agent))[0]).toMatch(/read$/);
  expect(open.connects.length).toBeGreaterThanOrEqual(connectsBefore);
});

it('round-trips a stored catalog', () => {
  const catalog: ToolCatalog = new Map([
    ['connector-0', { hash: 'a'.repeat(64), tools: [tool('read')] }],
  ]);
  expect(parseToolCatalog(serializeToolCatalog(catalog))).toEqual(catalog);
});

it.each([
  ['not JSON', '{'],
  ['an unknown version', JSON.stringify({ version: 2, connectors: [] })],
  [
    'a malformed definition hash',
    JSON.stringify({
      version: 1,
      connectors: [{ id: 'c', hash: 'x', tools: [] }],
    }),
  ],
  [
    'a tool without an input schema',
    JSON.stringify({
      version: 1,
      connectors: [{ id: 'c', hash: 'a'.repeat(64), tools: [{ name: 't' }] }],
    }),
  ],
  [
    'more than 256 tools',
    JSON.stringify({
      version: 1,
      connectors: [
        {
          id: 'c',
          hash: 'a'.repeat(64),
          tools: Array.from({ length: 257 }, (_, i) => tool(`t${i}`)),
        },
      ],
    }),
  ],
])('treats a stored catalog with %s as absent', (_case, text) => {
  expect(parseToolCatalog(text)).toBeUndefined();
});
