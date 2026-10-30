import { restrictedFetch, publicAddress } from '../adapters/mcp/http.js';
import { isIP } from 'node:net';
import { hashData } from '../runtime/registry.js';
import { AuthFault, validateRecipe, type OAuthRecipe } from './oauth-flow.js';

export interface OAuthDiscoveryOptions {
  // Construction-only: never accept a private-network exception from HTTP input.
  fixtureOrigin?: string;
  clientMetadataUrl?: string;
}
function url(value: unknown, options: OAuthDiscoveryOptions) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new AuthFault('unsupported');
  const parsed = new URL(value);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (
    ((isIP(host) && !publicAddress(host)) ||
      host === 'localhost' ||
      host.endsWith('.localhost')) &&
    parsed.origin !== options.fixtureOrigin
  )
    throw new AuthFault('unsupported');
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    (parsed.protocol !== 'https:' &&
      !(
        parsed.origin === options.fixtureOrigin &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.origin)
      ))
  )
    throw new AuthFault('unsupported');
  return parsed;
}
async function metadata(
  address: string,
  signal: AbortSignal,
  options: OAuthDiscoveryOptions,
) {
  url(address, options);
  const response = await restrictedFetch(
    address,
    signal,
    options.fixtureOrigin,
  )(address);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AuthFault('unsupported');
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AuthFault('invalid_response');
  return value as Record<string, unknown>;
}
function scopes(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        !/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(item),
    )
  )
    throw new AuthFault('unsupported');
  return [...new Set(value)] as string[];
}
export async function discoverOAuth(
  endpoint: string,
  signal: AbortSignal,
  options: OAuthDiscoveryOptions = {},
) {
  const resourceUrl = url(endpoint, options);
  // RFC 9728: prefer the protected resource's challenge, then path-specific and
  // origin metadata. These requests NEVER carry connector headers or tokens.
  const probe = await restrictedFetch(
    endpoint,
    signal,
    options.fixtureOrigin,
    {},
    true,
  )(endpoint, { headers: { accept: 'application/json' } });
  const challenge = probe.headers.get('www-authenticate');
  await probe.body?.cancel();
  const advertised =
    challenge && /^Bearer\s/i.test(challenge)
      ? [...challenge.matchAll(/\bresource_metadata="([^"\r\n]+)"/gi)]
      : [];
  if (advertised.length > 1) throw new AuthFault('invalid_response');
  const candidates = advertised.length
    ? [url(advertised[0]![1], options).href]
    : [
        ...new Set([
          `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === '/' ? '' : resourceUrl.pathname}`,
          `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
        ]),
      ];
  let resource: Record<string, unknown> | null = null;
  for (const address of candidates) {
    resource = await metadata(address, signal, options);
    if (resource) break;
  }
  if (
    !resource ||
    url(resource.resource, options).href !== resourceUrl.href ||
    !Array.isArray(resource.authorization_servers) ||
    !resource.authorization_servers.length ||
    resource.authorization_servers.length > 4
  )
    throw new AuthFault('unsupported');
  // Deterministic authority selection. Consent pins the resulting full metadata
  // fingerprint, so an issuer change between discovery and sign-in fails closed.
  const issuer = url(resource.authorization_servers[0], options);
  const issuerText = resource.authorization_servers[0] as string;
  const path = issuer.pathname === '/' ? '' : issuer.pathname;
  const locations = [
    ...new Set([
      `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuer.origin}/.well-known/openid-configuration${path}`,
      `${issuer.origin}${path}/.well-known/openid-configuration`,
    ]),
  ];
  let server: Record<string, unknown> | null = null,
    location = '';
  for (location of locations) {
    server = await metadata(location, signal, options);
    if (server) break;
  }
  if (
    !server ||
    server.issuer !== issuerText ||
    !Array.isArray(server.code_challenge_methods_supported) ||
    !server.code_challenge_methods_supported.includes('S256') ||
    (server.token_endpoint_auth_methods_supported !== undefined &&
      (!Array.isArray(server.token_endpoint_auth_methods_supported) ||
        !server.token_endpoint_auth_methods_supported.includes('none'))) ||
    (server.response_types_supported !== undefined &&
      (!Array.isArray(server.response_types_supported) ||
        !server.response_types_supported.includes('code')))
  )
    throw new AuthFault('unsupported');
  const clientId =
    server.client_id_metadata_document_supported === true &&
    options.clientMetadataUrl
      ? url(options.clientMetadataUrl, options).href
      : undefined;
  const register =
    typeof server.registration_endpoint === 'string'
      ? url(server.registration_endpoint, options).href
      : '';
  if (!clientId && !register) throw new AuthFault('unsupported');
  const recipe: OAuthRecipe = {
    id: 'generic',
    name: issuer.hostname,
    endpoint: resourceUrl.href,
    issuer: issuerText,
    metadata: location,
    authorize: url(server.authorization_endpoint, options).href,
    token: url(server.token_endpoint, options).href,
    register,
    resource: resourceUrl.href,
    scopes: scopes(resource.scopes_supported ?? server.scopes_supported ?? []),
    discovered: true,
    responseIssuerRequired:
      server.authorization_response_iss_parameter_supported === true,
    ...(server.revocation_endpoint
      ? { revocation: url(server.revocation_endpoint, options).href }
      : {}),
    ...(clientId ? { clientId } : {}),
    ...(options.fixtureOrigin ? { fixtureOrigin: options.fixtureOrigin } : {}),
  };
  validateRecipe(recipe);
  return { recipe, discoveryHash: hashData(recipe) };
}
