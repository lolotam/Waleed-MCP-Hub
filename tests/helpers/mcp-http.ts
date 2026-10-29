import { createServer, type ServerResponse } from 'node:http';

export async function mcpHttpFixture(
  requiredAuthorization?: string,
  echoCredential = false,
) {
  const methods: string[] = [];
  const headers: Array<Record<string, unknown>> = [];
  const channels = new Map<string, ServerResponse>();
  let active = 0;
  function result(
    method: string,
    params: Record<string, unknown>,
    mode: string,
  ) {
    if (method === 'initialize')
      return {
        protocolVersion:
          mode === 'version' ? '1900-01-01' : params.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'synthetic-mcp', version: '1.0.0' },
      };
    if (method === 'tools/list')
      return {
        tools: [
          {
            name: echoCredential
              ? (requiredAuthorization ?? '').replace(/^Bearer /, '')
              : params.cursor
                ? 'fixture_second'
                : 'fixture_first',
            inputSchema: { type: 'object' },
          },
          ...(params.cursor
            ? []
            : [{ name: 'mcp-add', inputSchema: { type: 'object' } }]),
        ],
        ...(mode === 'cursor'
          ? { nextCursor: 'repeat' }
          : params.cursor
            ? {}
            : { nextCursor: 'second' }),
      };
    if (method === 'resources/list')
      return {
        resources: [{ uri: 'fixture://resource', name: 'fixture resource' }],
      };
    if (method === 'prompts/list')
      return { prompts: [{ name: 'fixture_prompt' }] };
    return {};
  }
  const server = createServer(async (request, response) => {
    active++;
    response.once('close', () => active--);
    headers.push({ ...request.headers });
    const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
    const mode = path.slice(1);
    if (
      mode === 'auth' ||
      (requiredAuthorization &&
        request.headers.authorization !== requiredAuthorization)
    ) {
      response.writeHead(401);
      response.end('SYNTHETIC-AUTH-DETAILS-NOT-PUBLIC');
      return;
    }
    if (mode === 'redirect') {
      response.writeHead(302, { location: 'http://169.254.169.254/private' });
      response.end();
      return;
    }
    if (mode === 'sse' && request.method === 'GET') {
      channels.set('session', response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: endpoint\ndata: /messages?sessionId=session\n\n');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (message.method) methods.push(message.method);
    if (mode === 'stall') return;
    if (message.id === undefined) {
      response.writeHead(204);
      response.end();
      return;
    }
    const payload = {
      jsonrpc: '2.0',
      id: message.id,
      result: result(message.method ?? '', message.params ?? {}, mode),
    };
    if (mode === 'large') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...payload, padding: 'x'.repeat(1024 * 1024 + 1) }),
      );
      return;
    }
    if (mode === 'messages') {
      channels
        .get('session')
        ?.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': 'synthetic-session',
    });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic HTTP fixture failed.');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    methods,
    headers,
    active: () => active,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
