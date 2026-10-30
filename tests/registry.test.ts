import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createRegistryClient, parseRegistryServer } from '@waleed/hub-core';
const wrap = (server: Record<string, unknown>, status = 'active') => ({
  server: {
    name: 'io.github.synthetic/tools',
    title: 'Synthetic Tools',
    description: 'Read only publisher metadata',
    version: '2.0.0',
    ...server,
  },
  _meta: {
    'io.modelcontextprotocol.registry/official': { status, isLatest: true },
  },
});
it('parses safe remote, pinned npm/PyPI packages and required credentials without publisher defaults', () => {
  const result = parseRegistryServer(
    wrap({
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://example.test/mcp',
          headers: [
            {
              name: 'Authorization',
              isRequired: true,
              isSecret: true,
              default: 'SYNTHETIC-PUBLISHER-SECRET',
              value: 'SYNTHETIC-PUBLISHER-SECRET',
            },
          ],
        },
      ],
      packages: [
        {
          registryType: 'npm',
          registryBaseUrl: 'https://registry.npmjs.org',
          identifier: '@synthetic/mcp',
          version: '1.2.3',
          transport: { type: 'stdio' },
          environmentVariables: [
            { name: 'TOKEN', isRequired: true, isSecret: true },
          ],
          packageArguments: [{ type: 'positional', value: 'mcp' }],
        },
        {
          registryType: 'pypi',
          identifier: 'synthetic-mcp',
          version: '4.5.6',
          transport: { type: 'stdio' },
        },
      ],
    }),
  );
  expect(result!.options).toHaveLength(3);
  expect(result!.options[0]!.requirements[0]).toMatchObject({
    name: 'Authorization',
    location: 'header',
    required: true,
    secret: true,
  });
  expect(result!.options[1]!.prefill).toMatchObject({
    type: 'npx',
    packageVersion: '1.2.3',
    args: ['mcp'],
  });
  expect(result!.options[2]!.prefill).toMatchObject({
    type: 'uvx',
    packageVersion: '4.5.6',
  });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PUBLISHER-SECRET');
});
it.each(['latest', '^1.2.3', 'file:../other', 'git+https://example.test/repo'])(
  'does not turn %s into a runnable package suggestion',
  (version) => {
    const result = parseRegistryServer(
      wrap({
        packages: [
          {
            registryType: 'npm',
            identifier: 'synthetic',
            version,
            transport: { type: 'stdio' },
          },
        ],
      }),
    );
    expect(result).toMatchObject({ options: [], unsupportedOptions: 1 });
  },
);
it.each([
  'http://127.0.0.1/private',
  'https://169.254.169.254/private',
  'https://user:pass@example.test/mcp',
  'https://example.test/mcp?token=private',
  'https://example.test/{tenant}',
])('does not offer unsafe/template endpoint %s', (url) => {
  expect(
    parseRegistryServer(wrap({ remotes: [{ type: 'sse', url }] })),
  ).toMatchObject({ options: [], unsupportedOptions: 1 });
});
it('excludes inactive entries, custom package registries, runtime injection and unresolved argument values', () => {
  expect(parseRegistryServer(wrap({}, 'deleted'))).toBe(null);
  for (const extra of [
    { registryBaseUrl: 'https://foreign.test' },
    { runtimeArguments: [{ type: 'named', name: '--eval', value: 'bad' }] },
  ])
    expect(
      parseRegistryServer(
        wrap({
          packages: [
            {
              registryType: 'npm',
              identifier: 'synthetic',
              version: '1.2.3',
              transport: { type: 'stdio' },
              ...extra,
            },
          ],
        }),
      ),
    ).toMatchObject({ options: [], unsupportedOptions: 1 });
  const item = parseRegistryServer(
    wrap({
      packages: [
        {
          registryType: 'npm',
          identifier: 'synthetic',
          version: '1.2.3',
          transport: { type: 'stdio' },
          packageArguments: [
            { type: 'positional', isRequired: true, default: '/private/home' },
          ],
        },
      ],
    }),
  );
  expect(item!.options[0]!.prefill.args).toEqual([]);
  expect(item!.options[0]!.warnings.join(' ')).toContain('manually');
  expect(JSON.stringify(item)).not.toContain('/private/home');
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(mode = 'healthy') {
  const requests: Array<{ url: string; authorization: unknown }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url!,
      authorization: request.headers.authorization,
    });
    if (mode === 'redirect') {
      response.writeHead(302, { location: 'http://127.0.0.1/private' });
      response.end();
      return;
    }
    if (mode === 'oversize') {
      response.end('x'.repeat(1024 * 1024 + 1));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        servers: [
          wrap({ remotes: [{ type: 'sse', url: 'https://example.test/mcp' }] }),
        ],
        metadata: { nextCursor: 'io.github.synthetic/tools:2.0.0' },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    client: createRegistryClient({
      fixtureOrigin: `http://127.0.0.1:${address.port}`,
    }),
    requests,
  };
}
it('uses fixed official API paths, encoded search/cursors, bounded pages, and no credentials', async () => {
  const f = await fixture(),
    result = await f.client.search({
      search: 'tools & test',
      cursor: 'https://foreign.test/path?x=1',
      limit: 2,
    });
  expect(result.servers).toHaveLength(1);
  expect(result.source).toBe('https://registry.modelcontextprotocol.io');
  const request = new URL(
    f.requests[0]!.url,
    'https://registry.modelcontextprotocol.io',
  );
  expect(request.pathname).toBe('/v0.1/servers');
  expect(request.searchParams.get('search')).toBe('tools & test');
  expect(request.searchParams.get('version')).toBe('latest');
  expect(f.requests[0]!.authorization).toBeUndefined();
  await expect(
    f.client.search({ url: 'https://foreign.test' }),
  ).rejects.toBeDefined();
  await expect(f.client.search({ limit: 5000 })).rejects.toBeDefined();
  expect(f.requests).toHaveLength(1);
});
it.each(['redirect', 'oversize'])(
  'rejects %s registry responses with sanitized errors',
  async (mode) => {
    const f = await fixture(mode);
    await expect(f.client.search({ limit: 1 })).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Official registry metadata is unavailable or unsupported.',
    });
  },
);
