import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AuthReason } from '@waleed/contracts';
import { restrictedFetch, publicAddress } from '../adapters/mcp/http.js';

export interface OAuthRecipe {
  id: string;
  name: string;
  endpoint: string;
  issuer: string;
  metadata: string;
  authorize: string;
  token: string;
  register: string;
  resource: string;
  scopes: string[];
  fixtureOrigin?: string;
  discovered?: true;
  revocation?: string;
  clientId?: string;
  responseIssuerRequired?: boolean;
}
// Explicit, documented recipe only. No arbitrary auth-page URLs or account-cache
// extraction. Linear's metadata and read scope were inspected on 2026-10-28.
export const supportedOAuthRecipes: readonly OAuthRecipe[] = [
  {
    id: 'linear-readonly',
    name: 'Linear (read only)',
    endpoint: 'https://mcp.linear.app/mcp/readonly',
    issuer: 'https://mcp.linear.app',
    metadata: 'https://mcp.linear.app/.well-known/oauth-authorization-server',
    authorize: 'https://mcp.linear.app/authorize',
    token: 'https://mcp.linear.app/token',
    register: 'https://mcp.linear.app/register',
    resource: 'https://mcp.linear.app/mcp',
    scopes: ['read'],
  },
];
export class AuthFault extends Error {
  constructor(readonly reason: AuthReason) {
    super('Authentication operation failed.');
  }
}
export interface TokenBundle {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string;
  recipe?: OAuthRecipe;
}
export function validateRecipe(recipe: OAuthRecipe) {
  const origin = new URL(recipe.issuer).origin;
  const fixture =
    recipe.fixtureOrigin === origin &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
  for (const value of [
    recipe.issuer,
    recipe.metadata,
    recipe.authorize,
    recipe.token,
    ...(recipe.register ? [recipe.register] : []),
    ...(recipe.revocation ? [recipe.revocation] : []),
    ...(recipe.clientId ? [recipe.clientId] : []),
    recipe.endpoint,
    recipe.resource,
  ]) {
    const url = new URL(value);
    if (
      (!recipe.discovered && url.origin !== origin) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!(fixture && url.origin === origin) && url.protocol !== 'https:')
    )
      throw new AuthFault('unsupported');
  }
  if (
    recipe.scopes.length > 16 ||
    recipe.scopes.some(
      (scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(scope),
    )
  )
    throw new AuthFault('unsupported');
}
function transport(recipe: OAuthRecipe, signal: AbortSignal) {
  validateRecipe(recipe);
  return async (
    url: string,
    body?: unknown,
    form = false,
  ): Promise<Record<string, unknown>> => {
    const response = await restrictedFetch(
      url,
      signal,
      recipe.fixtureOrigin,
    )(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(body === undefined
          ? {}
          : {
              'content-type': form
                ? 'application/x-www-form-urlencoded'
                : 'application/json',
            }),
      },
      ...(body === undefined
        ? {}
        : {
            body: form
              ? new URLSearchParams(body as Record<string, string>).toString()
              : JSON.stringify(body),
          }),
    });
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new AuthFault('invalid_response');
    const result = raw as Record<string, unknown>;
    if (!response.ok || result.error)
      throw new AuthFault(
        result.error === 'access_denied' ? 'denied' : 'invalid_response',
      );
    return result;
  };
}
function tokenBytes(
  result: Record<string, unknown>,
  clientId: string,
  scopes: string[],
  now: () => number,
  previousRefresh?: string | null,
  recipe?: OAuthRecipe,
) {
  if (
    typeof result.access_token !== 'string' ||
    !result.access_token ||
    result.access_token.length > 3072 ||
    /[\s\0]/.test(result.access_token) ||
    typeof result.token_type !== 'string' ||
    result.token_type.toLowerCase() !== 'bearer'
  )
    throw new AuthFault('invalid_response');
  if (
    result.scope !== undefined &&
    (typeof result.scope !== 'string' ||
      result.scope.split(' ').some((scope) => !scopes.includes(scope)))
  )
    throw new AuthFault('invalid_response');
  if (
    result.expires_in !== undefined &&
    (typeof result.expires_in !== 'number' ||
      !Number.isInteger(result.expires_in) ||
      result.expires_in < 1 ||
      result.expires_in > 31 * 24 * 3600)
  )
    throw new AuthFault('invalid_response');
  if (
    result.refresh_token !== undefined &&
    (typeof result.refresh_token !== 'string' ||
      result.refresh_token.length > 3072 ||
      /[\s\0]/.test(result.refresh_token))
  )
    throw new AuthFault('invalid_response');
  const bundle: TokenBundle = {
    accessToken: result.access_token,
    refreshToken:
      typeof result.refresh_token === 'string'
        ? result.refresh_token
        : (previousRefresh ?? null),
    expiresAt:
      typeof result.expires_in === 'number'
        ? now() + result.expires_in * 1000
        : null,
    clientId,
    ...(recipe ? { recipe } : {}),
  };
  const value = Buffer.from(JSON.stringify(bundle));
  if (value.length > 8192) {
    value.fill(0);
    throw new AuthFault('invalid_response');
  }
  return value;
}
export async function beginOAuth(
  recipe: OAuthRecipe,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const request = transport(recipe, signal);
  if (new URL(recipe.authorize).origin !== recipe.fixtureOrigin) {
    const host = new URL(recipe.authorize).hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    if (
      !addresses.length ||
      addresses.some((item) => !publicAddress(item.address))
    )
      throw new AuthFault('unsupported');
  }
  const state = randomBytes(32),
    verifier = randomBytes(32);
  const callbackPath = recipe.clientId
    ? '/oauth/callback'
    : `/callback/${randomBytes(16).toString('hex')}`;
  let resolveCode!: (code: string) => void,
    rejectCode!: (error: unknown) => void,
    consumed = false,
    invalid = 0;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void code.catch(() => undefined);
  const listener = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'",
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const address = listener.address();
      const host =
        address && typeof address !== 'string'
          ? `127.0.0.1:${address.port}`
          : '';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${host}`);
      } catch {
        res.writeHead(400);
        res.end('Authorization response rejected.');
        return;
      }
      const states = url.searchParams.getAll('state');
      const received = Buffer.from(states[0] ?? '', 'base64url');
      const valid =
        req.method === 'GET' &&
        req.headers.host === host &&
        url.origin === `http://${host}` &&
        url.pathname === callbackPath &&
        states.length === 1 &&
        received.length === state.length &&
        timingSafeEqual(received, state) &&
        !consumed &&
        [...url.searchParams.keys()].every((key) =>
          ['state', 'code', 'error', 'error_description', 'iss'].includes(key),
        ) &&
        [...new Set(url.searchParams.keys())].every(
          (key) => url.searchParams.getAll(key).length === 1,
        ) &&
        (url.searchParams.has('iss')
          ? url.searchParams.get('iss') === recipe.issuer
          : recipe.responseIssuerRequired === false);
      received.fill(0);
      if (!valid) {
        res.writeHead(400);
        res.end('Authorization response rejected.');
        if (++invalid >= 5) rejectCode(new AuthFault('state_mismatch'));
        return;
      }
      consumed = true;
      const clearQuery = "history.replaceState(null, '', location.pathname)";
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'sha256-${createHash('sha256').update(clearQuery).digest('base64')}'; frame-ancestors 'none'; base-uri 'none'`,
      );
      res.writeHead(200);
      res.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorization received</title><p>Authorization response received. Return to the local hub.</p><script>${clearQuery}</script></html>`,
      );
      if (url.searchParams.has('error'))
        rejectCode(
          new AuthFault(
            url.searchParams.get('error') === 'access_denied'
              ? 'denied'
              : 'invalid_response',
          ),
        );
      else {
        const value = url.searchParams.get('code');
        if (!value || value.length > 2048 || /[\r\n\0]/.test(value))
          rejectCode(new AuthFault('invalid_response'));
        else resolveCode(value);
      }
    },
  );
  const abort = () => {
    rejectCode(new AuthFault('cancelled'));
    listener.closeAllConnections();
    listener.close();
  };
  const close = () => {
    signal.removeEventListener('abort', abort);
    rejectCode(new AuthFault('cancelled'));
    listener.closeAllConnections();
    listener.close();
    state.fill(0);
    verifier.fill(0);
  };
  try {
    if (signal.aborted) throw new AuthFault('cancelled');
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) throw new AuthFault('cancelled');
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new AuthFault('dependency_unavailable');
    const redirect = `http://127.0.0.1:${address.port}${callbackPath}`;
    if (recipe.clientId) {
      const client = await request(recipe.clientId);
      if (
        client.client_id !== recipe.clientId ||
        client.token_endpoint_auth_method !== 'none' ||
        !Array.isArray(client.redirect_uris) ||
        !client.redirect_uris.some((value) => {
          if (typeof value !== 'string') return false;
          const uri = new URL(value);
          return (
            uri.protocol === 'http:' &&
            uri.hostname === '127.0.0.1' &&
            !uri.username &&
            !uri.password &&
            !uri.search &&
            !uri.hash &&
            uri.pathname === callbackPath
          );
        })
      )
        throw new AuthFault('unsupported');
    }
    const metadata = await request(recipe.metadata);
    if (
      metadata.issuer !== recipe.issuer ||
      metadata.authorization_endpoint !== recipe.authorize ||
      metadata.token_endpoint !== recipe.token ||
      (recipe.register && metadata.registration_endpoint !== recipe.register) ||
      !Array.isArray(metadata.code_challenge_methods_supported) ||
      !metadata.code_challenge_methods_supported.includes('S256') ||
      (metadata.token_endpoint_auth_methods_supported !== undefined &&
        (!Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
          !metadata.token_endpoint_auth_methods_supported.includes('none'))) ||
      (recipe.responseIssuerRequired !== false &&
        metadata.authorization_response_iss_parameter_supported !== true) ||
      (metadata.scopes_supported !== undefined &&
        (!Array.isArray(metadata.scopes_supported) ||
          recipe.scopes.some(
            (scope) =>
              !(metadata.scopes_supported as unknown[]).includes(scope),
          )))
    )
      throw new AuthFault('unsupported');
    const registration = recipe.clientId
      ? { client_id: recipe.clientId }
      : await request(recipe.register, {
          client_name: 'Waleed MCP Hub',
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: recipe.scopes.join(' '),
        });
    if (
      typeof registration.client_id !== 'string' ||
      !registration.client_id ||
      registration.client_id.length > 2048 ||
      /[\s\0]/.test(registration.client_id) ||
      registration.client_secret ||
      (registration.token_endpoint_auth_method &&
        registration.token_endpoint_auth_method !== 'none')
    )
      throw new AuthFault('unsupported');
    const clientId = registration.client_id;
    const url = new URL(recipe.authorize);
    const verifierText = verifier.toString('base64url');
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: recipe.scopes.join(' '),
      resource: recipe.resource,
      state: state.toString('base64url'),
      code_challenge: createHash('sha256')
        .update(verifierText)
        .digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    return {
      authorizationUrl: url.href,
      close,
      async finish() {
        try {
          const authorizationCode = await code;
          if (signal.aborted) throw new AuthFault('cancelled');
          return tokenBytes(
            await request(
              recipe.token,
              {
                grant_type: 'authorization_code',
                code: authorizationCode,
                redirect_uri: redirect,
                client_id: clientId,
                code_verifier: verifierText,
                resource: recipe.resource,
              },
              true,
            ),
            clientId,
            recipe.scopes,
            now,
            undefined,
            recipe,
          );
        } finally {
          close();
        }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
export async function refreshOAuth(
  recipe: OAuthRecipe,
  previous: Buffer,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const bundle = JSON.parse(previous.toString('utf8')) as TokenBundle;
  if (!bundle.refreshToken || typeof bundle.clientId !== 'string')
    throw new AuthFault('unsupported');
  try {
    return tokenBytes(
      await transport(recipe, signal)(
        recipe.token,
        {
          grant_type: 'refresh_token',
          refresh_token: bundle.refreshToken,
          client_id: bundle.clientId,
          resource: recipe.resource,
        },
        true,
      ),
      bundle.clientId,
      recipe.scopes,
      now,
      bundle.refreshToken,
      bundle.recipe ?? recipe,
    );
  } catch {
    throw new AuthFault('refresh_failed');
  }
}

// RFC 7009 permits an empty success response and deliberately does not reveal
// whether a token existed. Never mistake local deletion for provider revocation.
export async function revokeOAuth(
  recipe: OAuthRecipe,
  previous: Buffer,
  signal: AbortSignal,
) {
  validateRecipe(recipe);
  if (!recipe.revocation) return false;
  const bundle = JSON.parse(previous.toString('utf8')) as TokenBundle;
  for (const [token, hint] of [
    [bundle.refreshToken, 'refresh_token'],
    [bundle.accessToken, 'access_token'],
  ]) {
    if (!token) continue;
    const response = await restrictedFetch(
      recipe.revocation,
      signal,
      recipe.fixtureOrigin,
    )(recipe.revocation, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: hint!,
        client_id: bundle.clientId,
      }).toString(),
    });
    await response.body?.cancel();
    if (!response.ok) throw new AuthFault('invalid_response');
  }
  return true;
}
