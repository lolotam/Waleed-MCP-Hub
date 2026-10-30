import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  StreamableHttpHeadersSchema,
  type ClientToken,
  CreateClientTokenRequestSchema,
  RevokeClientTokenRequestSchema,
  ClientTokenSchema,
} from '@waleed/contracts';
import { createHttpSessions, type HubLifecycle } from '@waleed/hub-core';

export function isLoopbackPeer(address: string | undefined) {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}
export function registerHttpMcp(
  app: FastifyInstance,
  lifecycle: HubLifecycle,
  now?: () => number,
) {
  const pool = createHttpSessions(lifecycle.http, now);
  const authenticated = new WeakMap<FastifyRequest, ClientToken>();
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config.mcpBearer !== true) return;
    if (!isLoopbackPeer(request.raw.socket.remoteAddress))
      return reply.code(403).send({
        error: 'loopback_required',
        message: 'Only a direct loopback peer may connect.',
      });
    // Repeated security headers are ambiguous even if Node normalizes them.
    const seen = new Set<string>();
    for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
      const name = request.raw.rawHeaders[index]!.toLowerCase();
      if (
        [
          'authorization',
          'mcp-session-id',
          'mcp-protocol-version',
          'origin',
          'host',
        ].includes(name)
      ) {
        if (seen.has(name))
          return reply.code(400).send({
            error: 'invalid_request',
            message: 'Ambiguous security headers.',
          });
        seen.add(name);
      }
    }
    const headers = StreamableHttpHeadersSchema.safeParse(request.headers);
    if (!headers.success)
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        error: 'bearer_required',
        message: 'A valid client Bearer token is required.',
      });
    const token = await lifecycle.http.tokens.authenticate(
      headers.data.authorization.slice(7),
    );
    if (!token)
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        error: 'bearer_required',
        message: 'A valid client Bearer token is required.',
      });
    authenticated.set(request, token);
  });
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    config: { mcpBearer: true },
    async handler(request, reply) {
      const token = authenticated.get(request)!;
      const body = request.body;
      const initializing =
        request.method === 'POST' &&
        body !== null &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        'method' in body &&
        body.method === 'initialize';
      const session = await pool.acquire(
        token,
        request.headers['mcp-session-id'] as string | undefined,
        initializing,
      );
      // DELETE closes the session itself; let the SDK finish its 200 response.
      if (request.method !== 'DELETE') session.track(reply.raw);
      reply.hijack();
      // Fastify's normal security headers are bypassed by raw SDK responses.
      reply.raw.setHeader('Cache-Control', 'no-store');
      reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
      request.raw.socket.setTimeout(0);
      reply.raw.once('close', session.done);
      reply.raw.once('finish', session.done);
      try {
        await session.transport.handleRequest(request.raw, reply.raw, body);
      } catch {
        await session.close();
        if (!reply.raw.headersSent && !reply.raw.destroyed) {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: 'MCP transport failed.' },
            }),
          );
        } else if (!reply.raw.writableEnded) reply.raw.destroy();
      }
    },
  });
  app.get('/api/http-tokens', async () => lifecycle.http.tokens.list());
  app.post('/api/http-tokens', async (request) =>
    lifecycle.http.tokens.create(
      CreateClientTokenRequestSchema.parse(request.body),
    ),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/http-tokens/:id',
    async (request) => {
      return lifecycle.http.tokens.revoke(
        ClientTokenSchema.shape.id.parse(request.params.id),
        RevokeClientTokenRequestSchema.parse(request.body),
      );
    },
  );
  // onClose waits for connections to drain; SSE must be closed before that wait.
  app.addHook('preClose', async () => pool.close());
}
