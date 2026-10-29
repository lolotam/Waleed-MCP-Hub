import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { OAuthRecipe } from '@waleed/hub-core';

export async function oauthFixture() {
  let origin = '',
    mode = 'healthy',
    registrations = 0,
    tokenRequests = 0;
  const clients = new Map<string, string>();
  const grants = new Map<
    string,
    { clientId: string; redirect: string; challenge: string }
  >();
  const methods: string[] = [];
  const token = 'SYNTHETIC_OAUTH_ACCESS_0123456789',
    refresh = 'SYNTHETIC_OAUTH_REFRESH_0123456789';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      response.end(
        JSON.stringify({
          issuer: mode === 'bad_metadata' ? 'https://foreign.test' : origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['read'],
          authorization_response_iss_parameter_supported: true,
        }),
      );
      return;
    }
    if (url.pathname === '/authorize') {
      const clientId = url.searchParams.get('client_id')!;
      const redirect = clients.get(clientId);
      if (!redirect || redirect !== url.searchParams.get('redirect_uri')) {
        response.writeHead(400);
        response.end('{}');
        return;
      }
      const callback = new URL(redirect);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set(
        'iss',
        mode === 'wrong_issuer' ? 'https://foreign.test' : origin,
      );
      if (mode === 'denied')
        callback.searchParams.set('error', 'access_denied');
      else {
        const code = `code-${grants.size + 1}`;
        grants.set(code, {
          clientId,
          redirect,
          challenge: url.searchParams.get('code_challenge')!,
        });
        callback.searchParams.set('code', code);
      }
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    if (url.pathname === '/register') {
      const input = JSON.parse(body) as { redirect_uris: string[] };
      registrations++;
      const id = `public-client-${registrations}`;
      clients.set(id, input.redirect_uris[0]!);
      response.end(
        JSON.stringify({ client_id: id, token_endpoint_auth_method: 'none' }),
      );
      return;
    }
    if (url.pathname === '/token') {
      tokenRequests++;
      if (mode === 'stall') return;
      const input = new URLSearchParams(body);
      if (input.get('grant_type') === 'authorization_code') {
        const grant = grants.get(input.get('code') ?? '');
        if (
          !grant ||
          grant.clientId !== input.get('client_id') ||
          grant.redirect !== input.get('redirect_uri') ||
          grant.challenge !==
            createHash('sha256')
              .update(input.get('code_verifier') ?? '')
              .digest('base64url')
        ) {
          response.writeHead(400);
          response.end('{"error":"invalid_grant"}');
          return;
        }
      } else if (input.get('refresh_token') !== refresh) {
        response.writeHead(400);
        response.end('{"error":"invalid_grant"}');
        return;
      }
      if (mode === 'token_failure' || mode === 'refresh_failure') {
        response.writeHead(400);
        response.end(
          '{"error":"invalid_grant","error_description":"SYNTHETIC-private-provider-diagnostics"}',
        );
        return;
      }
      response.end(
        JSON.stringify({
          access_token: token,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: mode === 'over_scope' ? 'read write' : 'read',
        }),
      );
      return;
    }
    if (url.pathname === '/mcp/readonly') {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401);
        response.end('{}');
        return;
      }
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (message.method) methods.push(message.method);
      if (message.id === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'synthetic-oauth-peer', version: '1' },
            }
          : {
              tools: [
                { name: 'fixture_read', inputSchema: { type: 'object' } },
              ],
            };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('OAuth fixture failed.');
  origin = `http://127.0.0.1:${address.port}`;
  const recipe: OAuthRecipe = {
    id: 'fixture-readonly',
    name: 'Synthetic OAuth fixture',
    endpoint: `${origin}/mcp/readonly`,
    issuer: origin,
    metadata: `${origin}/.well-known/oauth-authorization-server`,
    authorize: `${origin}/authorize`,
    token: `${origin}/token`,
    register: `${origin}/register`,
    resource: `${origin}/mcp`,
    scopes: ['read'],
    fixtureOrigin: origin,
  };
  return {
    recipe,
    token,
    refresh,
    methods,
    setMode(value: string) {
      mode = value;
    },
    report() {
      return { registrations, tokenRequests, methods };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
