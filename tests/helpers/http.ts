import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createLifecycle,
  memoryClientTokenStore,
  type PlaygroundConnect,
} from '@waleed/hub-core';
import type { HubState } from '@waleed/contracts';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from './memory-store.js';
import { playgroundFixture } from './playground.js';

export async function httpFixture(
  options: Parameters<typeof playgroundFixture>[0] = {},
  configuration: { state?: HubState; connect?: PlaygroundConnect } = {},
) {
  const peer = playgroundFixture(options);
  const store = memoryStore(configuration.state ?? peer.state),
    tokenStore = memoryClientTokenStore();
  let clock = Date.now();
  const hub = createLifecycle(store, () => clock, undefined, {
    clientTokens: tokenStore,
    playgroundConnect: configuration.connect ?? peer.connect,
  });
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === 'string')
    throw new Error('No ephemeral port.');
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await createHubServer({
    port,
    lifecycle: hub,
    now: () => clock,
  });
  const host = `127.0.0.1:${port}`,
    url = `http://${host}/mcp`;
  const clients: Client[] = [];
  await server.app.listen({ host: '127.0.0.1', port });
  return {
    ...peer,
    hub,
    store,
    tokenStore,
    server,
    host,
    url,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    async token(extra: Record<string, unknown> = {}) {
      const value = await hub.http.tokens.list();
      return hub.http.tokens.create({
        expectedRevision: value.revision,
        label: 'Synthetic HTTP client',
        ...extra,
      });
    },
    async client(secret: string) {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
        reconnectionOptions: {
          maxRetries: 0,
          maxReconnectionDelay: 100,
          initialReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1,
        },
      });
      const client = new Client(
        { name: 'synthetic-http-client', version: '1' },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(transport);
      return { client, transport };
    },
    async browser() {
      const headers = { host, origin: `http://${host}` };
      const session = await server.app.inject({
        method: 'POST',
        url: '/api/session',
        headers,
        payload: { token: server.issueLaunchToken() },
      });
      return {
        ...headers,
        cookie: session.headers['set-cookie']!.toString().split(';')[0]!,
        'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
      };
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.app.close();
      await peer.playground.close();
    },
  };
}
