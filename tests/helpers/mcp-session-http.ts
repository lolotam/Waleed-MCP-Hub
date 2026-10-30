import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

export interface SessionMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export interface SessionEvent {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  // The JSON-RPC messages of a POST body.
  messages: SessionMessage[];
  request: IncomingMessage;
  response: ServerResponse;
}

export interface SessionFixtureOptions {
  // The transport the endpoint speaks.
  transport?: 'streamable_http' | 'sse';
  // Bytes of padding in the tools/list result.
  catalogBytes?: number;
  // Bytes of padding in the tools/call result.
  callBytes?: number;
  // Bytes of an image in the tools/call result.
  imageBytes?: number;
  // The GET stream ends as soon as it is open.
  closeGet?: boolean;
  // A request that carries the session id is refused with 404.
  notFound?: boolean;
  // The status of the DELETE answer.
  deleteStatus?: number;
  // The DELETE never answers.
  deleteStalls?: boolean;
  // The DELETE sends its headers and stalls its body.
  deleteStallsBody?: boolean;
  // The DELETE trickles an incomplete header block: the socket stays busy
  // and the answer never arrives.
  deleteTrickle?: boolean;
  // The POST replies never get their headers.
  withholdPosts?: boolean;
  // The initialize answer carries a protocol version the SDK refuses.
  badProtocol?: boolean;
}

export interface SessionFixture {
  origin: string;
  // The options are read on every request, so a test may change them.
  options: SessionFixtureOptions;
  // The number of session requests that are refused with 404.
  refusals: number;
  readonly seen: SessionEvent[];
  // The handler of every request; the default answers like an MCP server.
  handler: (event: SessionEvent) => void | Promise<void>;
  // The open sockets of the server.
  openConnections(): number;
  // The open POST sockets: the connection of every POST that waits.
  openPosts(): number;
  // The open POST responses: the connection of every POST that waits.
  postConnections(): ServerResponse[];
  peakConnections(): number;
  peakPosts(): number;
  // The closed sockets of the server.
  closedConnections(): number;
  // The POST sockets the client closed.
  closedPosts(): number;
  // The POST bodies that were withheld: they are answered on demand.
  answerWithheld(): void;
  // Writes to the open GET streams.
  push(text: string): void;
  // Ends the open GET streams.
  closeStreams(): void;
  close(): Promise<void>;
}

// The result of one JSON-RPC method.
export function sessionResult(
  message: SessionMessage,
  options: SessionFixtureOptions,
) {
  if (message.method === 'initialize')
    return {
      protocolVersion: options.badProtocol
        ? '1999-01-01'
        : typeof message.params?.protocolVersion === 'string'
          ? message.params.protocolVersion
          : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'synthetic-session', version: '1.0.0' },
    };
  if (message.method === 'tools/list')
    return {
      tools: [{ name: 'fixture_first', inputSchema: { type: 'object' } }],
      ...(options.catalogBytes
        ? { padding: 'x'.repeat(options.catalogBytes) }
        : {}),
    };
  if (message.method === 'tools/call')
    return {
      content: [
        { type: 'text', text: 'synthetic success' },
        ...(options.imageBytes
          ? [
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'A'.repeat(options.imageBytes),
              },
            ]
          : []),
      ],
      ...(options.callBytes ? { padding: 'x'.repeat(options.callBytes) } : {}),
    };
  return {};
}

// The local fixture of the remote session mode: raw HTTP on 127.0.0.1, so the
// test controls the framing of every response.
export async function mcpSessionFixture(
  options: SessionFixtureOptions = {},
): Promise<SessionFixture> {
  const seen: SessionEvent[] = [];
  const open = new Map<ServerResponse, string>();
  const sockets = new Set<Socket>();
  // The method of the request every open socket carries. The POSTs are
  // counted by their sockets, not by their responses: a socket is closed
  // when the connection ends.
  const socketMethods = new Map<Socket, string>();
  const withheld: SessionEvent[] = [];
  let peak = 0;
  let peakPost = 0;
  let closed = 0;
  let closedPost = 0;
  const postSockets = () =>
    [...socketMethods.values()].filter((method) => method === 'POST').length;
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    open.set(response, method);
    socketMethods.set(request.socket, method);
    peakPost = Math.max(peakPost, postSockets());
    response.once('close', () => {
      open.delete(response);
    });
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.once('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
      let messages: SessionMessage[] = [];
      try {
        const parsed = JSON.parse(body) as unknown;
        messages = (Array.isArray(parsed) ? parsed : [parsed]).filter(
          (item): item is SessionMessage =>
            typeof item === 'object' && item !== null,
        );
      } catch {
        /* Not a JSON body. */
      }
      const event: SessionEvent = {
        method: request.method ?? 'GET',
        path,
        headers: request.headers,
        body,
        messages,
        request,
        response,
      };
      seen.push(event);
      void Promise.resolve()
        .then(() => fixture.handler(event))
        .catch(() => {
          if (!response.writableEnded) {
            response.writeHead(500);
            response.end();
          }
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The open sockets of the server: a request that waits for its answer holds
  // a socket of its own.
  server.on('connection', (socket) => {
    sockets.add(socket);
    peak = Math.max(peak, sockets.size);
    socket.once('close', () => {
      sockets.delete(socket);
      closed += 1;
      if (socketMethods.get(socket) === 'POST') closedPost += 1;
      socketMethods.delete(socket);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic session fixture failed.');
  const origin = `http://127.0.0.1:${address.port}`;
  const streams = () =>
    [...open.entries()]
      .filter(([, method]) => method === 'GET')
      .map(([response]) => response);
  const answer = (event: SessionEvent) => {
    const message = event.messages[0];
    if (!message || message.id === undefined) {
      event.response.writeHead(202);
      event.response.end();
      return;
    }
    const payload = {
      jsonrpc: '2.0',
      id: message.id,
      result: sessionResult(message, options),
    };
    if (options.transport === 'sse') {
      // The legacy transport answers on the main stream.
      for (const stream of streams())
        stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      event.response.writeHead(202);
      event.response.end();
      return;
    }
    event.response.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': 'synthetic-session',
    });
    event.response.end(JSON.stringify(payload));
  };
  const fixture: SessionFixture = {
    origin,
    options,
    refusals: 0,
    seen,
    handler: (event) => {
      const { response } = event;
      if (event.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        // The headers reach the client at once: the stream stays open and
        // quiet.
        response.flushHeaders();
        if (options.transport === 'sse')
          response.write(
            'event: endpoint\ndata: /messages?sessionId=session\n\n',
          );
        if (options.closeGet) response.end();
        return;
      }
      if (event.method === 'DELETE') {
        if (options.deleteStalls) return;
        if (options.deleteTrickle) {
          // The header block never ends: the answer never arrives and the
          // socket stays busy, so its inactivity timeout never fires. Only
          // the dedicated bound of the client ends the termination.
          const socket = event.request.socket;
          socket.write('HTTP/1.1 200 OK\r\n');
          const trickle = setInterval(() => {
            socket.write(`X-Trickle: ${'x'.repeat(64)}\r\n`);
          }, 1000);
          socket.once('close', () => clearInterval(trickle));
          return;
        }
        if (options.deleteStallsBody) {
          // The headers of the answer arrive, its body never does: the socket
          // timeout of the client covers the headers only.
          response.writeHead(options.deleteStatus ?? 200);
          response.flushHeaders();
          return;
        }
        response.writeHead(options.deleteStatus ?? 200);
        response.end();
        return;
      }
      if (event.method !== 'POST') {
        response.writeHead(405);
        response.end();
        return;
      }
      if (
        options.notFound &&
        fixture.refusals > 0 &&
        event.headers['mcp-session-id']
      ) {
        fixture.refusals -= 1;
        response.writeHead(404);
        response.end();
        return;
      }
      // The headers of this reply never arrive: the POST stays open. The
      // handshake and the notifications are answered as usual.
      const message = event.messages[0];
      if (
        options.withholdPosts &&
        message?.id !== undefined &&
        message.method !== 'initialize'
      ) {
        withheld.push(event);
        return;
      }
      answer(event);
    },
    openConnections: () => sockets.size,
    openPosts: () => postSockets(),
    postConnections: () =>
      [...open.entries()]
        .filter(([, method]) => method === 'POST')
        .map(([response]) => response),
    peakConnections: () => peak,
    peakPosts: () => peakPost,
    closedConnections: () => closed,
    closedPosts: () => closedPost,
    answerWithheld: () => {
      for (const event of withheld.splice(0)) answer(event);
    },
    push: (text) => {
      for (const stream of streams()) stream.write(text);
    },
    closeStreams: () => {
      for (const stream of streams()) stream.end();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fixture;
}
