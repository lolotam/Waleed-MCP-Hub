import { isIP } from 'node:net';
import {
  RegistrySearchSchema,
  RegistryServerSchema,
  RegistryResultSchema,
  EndpointSchema,
  PackageSpecSchema,
  type RegistryOption,
  type RegistryServer,
} from '@waleed/contracts';
import { restrictedFetch, publicAddress } from '../adapters/mcp/http.js';
import { HubError } from '../errors.js';
import { assertBinding } from '../auth/bindings.js';
import { object } from './metadata.js';

export const officialRegistryOrigin =
  'https://registry.modelcontextprotocol.io';
const unsupported = () =>
  new HubError(
    'unavailable',
    'Official registry metadata is unavailable or unsupported.',
  );
const text = (value: unknown, limit: number, fallback = '') =>
  typeof value === 'string' &&
  ![...value].some((char) => {
    const c = char.charCodeAt(0);
    return c < 32 || c === 127;
  })
    ? value.slice(0, limit)
    : fallback;
function requirements(raw: unknown, location: 'environment' | 'header') {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 64) throw unsupported();
  const seen = new Set<string>();
  return raw.map((value) => {
    const item = object(value);
    if (
      !item ||
      typeof item.name !== 'string' ||
      seen.has(item.name.toLowerCase())
    )
      throw unsupported();
    assertBinding(location, item.name, 'raw');
    seen.add(item.name.toLowerCase());
    // Publisher values/defaults, including non-secret ones, are not credentials
    // and are never copied into the browser form or saved to the vault.
    return {
      name: item.name,
      location,
      required: item.isRequired === true,
      secret: item.isSecret === true,
      description: text(item.description, 1000),
    };
  });
}
export function parseRegistryServer(raw: unknown): RegistryServer | null {
  const wrapper = object(raw),
    server = object(wrapper?.server);
  if (!server) return null;
  const official = object(
    object(wrapper?._meta)?.['io.modelcontextprotocol.registry/official'],
  );
  if (official?.status !== 'active') return null;
  if (
    typeof server.name !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i.test(server.name) ||
    server.name.length > 200 ||
    typeof server.version !== 'string' ||
    server.version.length > 100
  )
    return null;
  const options: RegistryOption[] = [],
    title = text(
      server.title,
      100,
      text(server.name.split('/').at(-1), 100, 'Registry server'),
    );
  let unsupportedOptions = 0;
  for (const [index, value] of (Array.isArray(server.remotes)
    ? server.remotes.slice(0, 32)
    : []
  ).entries())
    try {
      const remote = object(value);
      if (
        !remote ||
        !['streamable-http', 'sse'].includes(String(remote.type)) ||
        !EndpointSchema.safeParse(remote.url).success ||
        /[{}]/.test(String(remote.url)) ||
        remote.variables
      )
        throw unsupported();
      const url = new URL(remote.url as string),
        host = url.hostname.replace(/^\[|\]$/g, '');
      if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        (isIP(host) && !publicAddress(host))
      )
        throw unsupported();
      options.push({
        id: `remote-${index}`,
        prefill: {
          name: title,
          type: remote.type === 'sse' ? 'sse' : 'streamable_http',
          url: url.href,
          args: [],
        },
        requirements: requirements(remote.headers, 'header'),
        warnings: [
          'Publisher metadata is untrusted. Review the endpoint and required credentials.',
        ],
      });
    } catch {
      unsupportedOptions++;
    }
  for (const [index, value] of (Array.isArray(server.packages)
    ? server.packages.slice(0, 32)
    : []
  ).entries())
    try {
      const pkg = object(value);
      if (
        !pkg ||
        !['npm', 'pypi'].includes(String(pkg.registryType)) ||
        object(pkg.transport)?.type !== 'stdio'
      )
        throw unsupported();
      const base =
        pkg.registryType === 'npm'
          ? 'https://registry.npmjs.org'
          : 'https://pypi.org';
      if (
        pkg.registryBaseUrl !== undefined &&
        String(pkg.registryBaseUrl).replace(/\/$/, '') !== base
      )
        throw unsupported();
      if (
        pkg.runtimeArguments !== undefined &&
        (!Array.isArray(pkg.runtimeArguments) || pkg.runtimeArguments.length)
      )
        throw unsupported();
      const name = String(pkg.identifier),
        entryPoint = name.split('/').at(-1)!;
      const spec = PackageSpecSchema.parse({
        manager: pkg.registryType === 'npm' ? 'npm' : 'uvx',
        name,
        version: pkg.version,
        entryPoint,
      });
      const args: string[] = [],
        warnings = [
          'Confirm the package executable name; registry metadata may not specify its bin entry.',
          'Pinned package preparation still requires separate execution approval.',
        ];
      if (
        pkg.packageArguments !== undefined &&
        !Array.isArray(pkg.packageArguments)
      )
        throw unsupported();
      for (const value of (pkg.packageArguments as unknown[] | undefined) ??
        []) {
        const arg = object(value);
        if (!arg) throw unsupported();
        if (
          arg.isSecret === true ||
          arg.variables ||
          typeof arg.value !== 'string' ||
          /[{}\0\r\n]/.test(arg.value)
        ) {
          if (
            !warnings.includes(
              'Additional package arguments must be reviewed and supplied manually.',
            )
          )
            warnings.push(
              'Additional package arguments must be reviewed and supplied manually.',
            );
          continue;
        }
        if (arg.type === 'named') {
          if (
            typeof arg.name !== 'string' ||
            !/^--?[a-zA-Z][a-zA-Z0-9-]*$/.test(arg.name)
          )
            throw unsupported();
          args.push(arg.name);
        } else if (arg.type !== 'positional') throw unsupported();
        args.push(arg.value);
      }
      if (args.length > 128) throw unsupported();
      options.push({
        id: `package-${index}`,
        prefill: {
          name: title,
          type: pkg.registryType === 'npm' ? 'npx' : 'uvx',
          packageName: spec.name,
          packageVersion: spec.version,
          entryPoint: spec.entryPoint,
          args,
        },
        requirements: requirements(pkg.environmentVariables, 'environment'),
        warnings,
      });
    } catch {
      unsupportedOptions++;
    }
  if (options.length > 32) return null;
  const result = RegistryServerSchema.safeParse({
    name: server.name,
    title,
    description: text(server.description, 1000),
    version: server.version,
    options,
    unsupportedOptions,
  });
  return result.success ? result.data : null;
}
export function createRegistryClient(options: { fixtureOrigin?: string } = {}) {
  return {
    async search(
      raw: unknown,
      signal: AbortSignal = AbortSignal.timeout(10_000),
    ) {
      const input = RegistrySearchSchema.parse(raw);
      const base = options.fixtureOrigin ?? officialRegistryOrigin;
      if (
        options.fixtureOrigin &&
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.fixtureOrigin)
      )
        throw unsupported();
      const address = new URL('/v0.1/servers', base);
      address.searchParams.set('limit', String(input.limit));
      address.searchParams.set('version', 'latest');
      if (input.search) address.searchParams.set('search', input.search);
      if (input.cursor) address.searchParams.set('cursor', input.cursor);
      try {
        const response = await restrictedFetch(
          base,
          signal,
          options.fixtureOrigin,
        )(address.href, { headers: { accept: 'application/json' } });
        if (!response.ok) {
          await response.body?.cancel();
          throw unsupported();
        }
        const result = object(await response.json());
        if (
          !result ||
          !Array.isArray(result.servers) ||
          result.servers.length > input.limit
        )
          throw unsupported();
        const next = object(result.metadata)?.nextCursor;
        if (next !== undefined && next !== null && typeof next !== 'string')
          throw unsupported();
        return RegistryResultSchema.parse({
          source: officialRegistryOrigin,
          servers: result.servers
            .map(parseRegistryServer)
            .filter((server) => server !== null),
          nextCursor: next || null,
        });
      } catch {
        throw unsupported();
      }
    },
  };
}
