import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createAgentBridge } from '@waleed/hub-core';
import type { HubState } from '@waleed/contracts';
import { profileState } from './helpers/runtime.js';

const manifestVersion = (path: string) =>
  (
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

// A real bridge over a real MCP client. Every connector's peer lists `tools`.
async function connectAgent(
  state: HubState,
  tools: Tool[] = [],
  separator: '__' | '_' = '__',
) {
  const bridge = createAgentBridge(
    async () => structuredClone(state),
    async () => {
      const peer = new Server(
        { name: 'guide-peer', version: '1' },
        { capabilities: { tools: {} } },
      );
      peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      const [a, b] = InMemoryTransport.createLinkedPair();
      await peer.connect(a);
      const client = new Client({ name: 'guide-client', version: '1' });
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
    undefined,
    undefined,
    undefined,
    separator,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client({ name: 'guide-agent', version: '1' });
  await agent.connect(b);
  open.push(async () => {
    await agent.close();
    await bridge.close();
  });
  return agent;
}

it('reports the hub-core release version, which matches the root version', async () => {
  const agent = await connectAgent(profileState([]));
  const hubCore = manifestVersion('../packages/hub-core/package.json');
  expect(agent.getServerVersion()?.version).toBe(hubCore);
  expect(hubCore).toBe(manifestVersion('../package.json'));
});
