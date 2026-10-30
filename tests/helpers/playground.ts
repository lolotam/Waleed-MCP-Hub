import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createPlayground, createRequestLog } from '@waleed/hub-core';
import { assertNoCredentialEcho } from '../../packages/hub-core/src/integrations/bridge.js';
import { profileState } from './runtime.js';

export function playgroundFixture(
  options: {
    now?: () => number;
    secret?: string;
    result?: unknown;
    listGate?: Promise<void>;
    callGate?: Promise<void>;
    onCall?: () => void;
  } = {},
) {
  const state = profileState(['native']),
    log = createRequestLog(),
    calls: unknown[] = [],
    peers: { started: number; closed: number } = { started: 0, closed: 0 };
  let tools: Tool[] = [
    {
      name: 'read',
      description: 'Read synthetic data',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
      },
    },
  ];
  const connect = async () => {
    peers.started++;
    const server = new Server(
      { name: 'synthetic-playground', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await options.listGate;
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(structuredClone(request.params));
      options.onCall?.();
      await options.callGate;
      return (
        options.result ?? {
          content: [{ type: 'text', text: 'synthetic success' }],
        }
      );
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client(
      { name: 'synthetic-playground-client', version: '1' },
      { capabilities: {} },
    );
    await client.connect(b);
    return {
      client,
      assertPublic(value: unknown) {
        assertNoCredentialEcho(value, options.secret ? [options.secret] : []);
      },
      async dispose() {
        peers.closed++;
        await client.close();
        await server.close();
      },
    };
  };
  const playground = createPlayground(
    async () => structuredClone(state),
    log,
    connect,
    options.now,
  );
  const input = () => ({
    connectorId: 'connector-0',
    toolName: 'read',
    confirmExecute: true,
  });
  const run = async (extra: Record<string, unknown> = {}) => {
    const job = playground.invoke({ ...input(), ...extra }, 'owner');
    await playground.drain();
    return playground.job(job.id, 'owner');
  };
  return {
    state,
    log,
    calls,
    peers,
    playground,
    connect,
    input,
    run,
    tools,
    setTools(value: Tool[]) {
      tools = value;
    },
  };
}
