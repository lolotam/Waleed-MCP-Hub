import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createAgentBridge, definitionHash } from '@waleed/hub-core';
import { safeMcpHttpTransport } from '../packages/hub-core/src/adapters/mcp/http.js';
import { profileState } from './helpers/runtime.js';

it.each(['127.0.0.1', 'localhost'])(
  'reuses an opted-in local HTTP session at %s and sends DELETE before closing its transport',
  async (hostname) => {
    let initialized = 0,
      deleted = 0,
      opened = false;
    const sessionIds: Array<string | undefined> = [];
    const http = createServer(async (request, response) => {
      if (request.method === 'DELETE') {
        expect(request.headers['mcp-session-id']).toBe(
          'synthetic-persistent-id',
        );
        deleted++;
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const m = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { name: string; protocolVersion: string };
      };
      if (m.id === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      let result;
      if (m.method === 'initialize') {
        initialized++;
        result = {
          protocolVersion: m.params!.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-http', version: '1' },
        };
      } else if (m.method === 'tools/list')
        result = {
          tools: ['open', 'read'].map((name) => ({
            name,
            inputSchema: { type: 'object' },
          })),
        };
      else {
        sessionIds.push(
          request.headers['mcp-session-id'] as string | undefined,
        );
        if (m.params?.name === 'open') opened = true;
        result = {
          content: [
            {
              type: 'text',
              text: opened ? 'HTTP session retained' : 'HTTP session missing',
            },
          ],
        };
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'synthetic-persistent-id',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error();
    const origin = `http://${hostname}:${address.port}`;
    const state = profileState(['remote']);
    const connector = state.connectors[0]!;
    if (connector.executionMode !== 'remote') throw new Error();
    connector.endpoint = origin + '/mcp';
    connector.localHttpOptIn = true;
    connector.trustApproval!.definitionHash = definitionHash(connector);
    const bridge = createAgentBridge(
      async () => state,
      async (_connector, signal) => {
        const client = new Client(
          { name: 'synthetic-peer', version: '1' },
          { capabilities: {} },
        );
        const transport = safeMcpHttpTransport(
          origin + '/mcp',
          'streamable_http',
          signal,
          undefined,
          {},
          true,
        );
        await client.connect(transport);
        return {
          client,
          assertPublic() {},
          async dispose() {
            try {
              await transport.terminateSession?.();
            } finally {
              await client.close();
            }
          },
        };
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
      await agent.listTools();
      await agent.callTool({ name: 'connector-0__open' });
      expect(await agent.callTool({ name: 'connector-0__read' })).toMatchObject(
        {
          content: [{ text: 'HTTP session retained' }],
        },
      );
      expect(initialized).toBe(1);
      expect(sessionIds).toEqual([
        'synthetic-persistent-id',
        'synthetic-persistent-id',
      ]);
      connector.localHttpOptIn = false;
      expect(await agent.callTool({ name: 'connector-0__read' })).toMatchObject(
        { isError: true },
      );
      expect(sessionIds).toHaveLength(2);
      await agent.close();
      await bridge.close();
      expect(deleted).toBe(1);
    } finally {
      await agent.close();
      await bridge.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);
