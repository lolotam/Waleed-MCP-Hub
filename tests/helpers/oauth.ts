import { createServer, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { OAuthRecipe } from '@waleed/hub-core';

export async function oauthFixture(
  options: {
    issuerPath?: string;
    rootResourceOnly?: boolean;
    oidcOnly?: boolean;
  } = {},
) {
  let origin = '',
    mode = 'healthy',
    registrations = 0,
    tokenRequests = 0,
    refreshRequests = 0,
    generation = 0;
  const revoked: string[] = [],
    resources: Array<string | null> = [],
    bearerHeaders: string[] = [];
  let activeToken = '',
    activeRefresh = '';
  let events: ServerResponse | undefined;
  const clients = new Map<string, string>();
  const grants = new Map<
    string,
    { clientId: string; redirect: string; challenge: string }
  >();
  const methods: string[] = [];
  const token = 'SYNTHETIC_OAUTH_ACCESS_0123456789',
    refresh = 'SYNTHETIC_OAUTH_REFRESH_0123456789';
  activeToken = token;
  activeRefresh = refresh;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    response.setHeader('content-type', 'application/json');
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (mode === 'resource_redirect') {
        response.writeHead(302, { location: 'http://127.0.0.1/private' });
        response.end();
        return;
      }
      if (
        options.rootResourceOnly &&
        url.pathname !== '/.well-known/oauth-protected-resource'
      ) {
        response.writeHead(404);
        response.end('{}');
        return;
      }
      if (mode === 'no_resource_metadata') {
        response.writeHead(404);
        response.end('{}');
        return;
      }
      response.end(
        JSON.stringify({
          resource:
            mode === 'wrong_resource'
              ? 'https://foreign.test/mcp'
              : `${origin}/mcp/readonly`,
          authorization_servers: [`${origin}${options.issuerPath ?? ''}`],
          scopes_supported: ['read'],
        }),
      );
      return;
    }
    if (
      url.pathname ===
      `/.well-known/${options.oidcOnly ? 'openid-configuration' : 'oauth-authorization-server'}${options.issuerPath ?? ''}`
    ) {
      response.end(
        JSON.stringify({
          issuer:
            mode === 'bad_metadata'
              ? 'https://foreign.test'
              : `${origin}${options.issuerPath ?? ''}`,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(mode === 'no_registration' || mode === 'metadata_document'
            ? {}
            : { registration_endpoint: `${origin}/register` }),
          ...(mode === 'metadata_document'
            ? { client_id_metadata_document_supported: true }
            : {}),
          ...(mode === 'no_revocation'
            ? {}
            : { revocation_endpoint: `${origin}/revoke` }),
          code_challenge_methods_supported:
            mode === 'no_pkce' ? ['plain'] : ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['read'],
          authorization_response_iss_parameter_supported: mode !== 'no_iss',
        }),
      );
      return;
    }
    if (url.pathname === '/authorize') {
      const clientId = url.searchParams.get('client_id')!;
      const redirect =
        clientId === `${origin}/client.json`
          ? url.searchParams.get('redirect_uri')
          : clients.get(clientId);
      if (!redirect || redirect !== url.searchParams.get('redirect_uri')) {
        response.writeHead(400);
        response.end('{}');
        return;
      }
      const callback = new URL(redirect);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      if (mode !== 'no_iss')
        callback.searchParams.set(
          'iss',
          mode === 'wrong_issuer'
            ? 'https://foreign.test'
            : `${origin}${options.issuerPath ?? ''}`,
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
    if (url.pathname === '/client.json') {
      response.end(
        JSON.stringify({
          client_id: `${origin}/client.json`,
          token_endpoint_auth_method: 'none',
          redirect_uris: ['http://127.0.0.1/oauth/callback'],
        }),
      );
      return;
    }
    if (
      url.pathname === '/mcp/readonly' &&
      request.method === 'GET' &&
      request.headers.accept === 'text/event-stream' &&
      request.headers.authorization === `Bearer ${activeToken}`
    ) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      events = response;
      response.write(`event: endpoint\ndata: ${origin}/messages\n\n`);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    if (url.pathname === '/revoke') {
      if (mode === 'revocation_failure') {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      revoked.push(new URLSearchParams(body).get('token')!);
      response.end();
      return;
    }
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
      resources.push(input.get('resource'));
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
      } else if (input.get('refresh_token') !== activeRefresh) {
        response.writeHead(400);
        response.end('{"error":"invalid_grant"}');
        return;
      }
      if (input.get('grant_type') === 'refresh_token') {
        refreshRequests++;
        if (mode === 'rotation') {
          generation++;
          activeToken = `${token}_${generation}`;
          activeRefresh = `${refresh}_${generation}`;
        }
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
          access_token: activeToken,
          ...(mode === 'omit_refresh' ? {} : { refresh_token: activeRefresh }),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: mode === 'over_scope' ? 'read write' : 'read',
        }),
      );
      return;
    }
    if (url.pathname === '/mcp/readonly' || url.pathname === '/messages') {
      if (request.headers.authorization !== `Bearer ${activeToken}`) {
        if (!options.rootResourceOnly)
          response.setHeader(
            'www-authenticate',
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/readonly"`,
          );
        response.writeHead(401);
        response.end('{}');
        return;
      }
      bearerHeaders.push(request.headers.authorization);
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
          : message.method === 'tools/call'
            ? {
                content: [
                  { type: 'text', text: 'Synthetic authorized result' },
                ],
              }
            : {
                tools: [
                  { name: 'fixture_read', inputSchema: { type: 'object' } },
                ],
              };
      const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      if (url.pathname === '/messages') {
        events?.write(`event: message\ndata: ${reply}\n\n`);
        response.writeHead(202);
        response.end();
      } else response.end(reply);
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
    issuer: `${origin}${options.issuerPath ?? ''}`,
    metadata: `${origin}/.well-known/oauth-authorization-server${options.issuerPath ?? ''}`,
    authorize: `${origin}/authorize`,
    token: `${origin}/token`,
    register: `${origin}/register`,
    revocation: `${origin}/revoke`,
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
      return {
        registrations,
        tokenRequests,
        refreshRequests,
        methods,
        revoked,
        resources,
        bearerHeaders,
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
