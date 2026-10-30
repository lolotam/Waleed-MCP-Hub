import { afterEach, expect, it, vi } from 'vitest';
import {
  EndpointSchema,
  ConnectorSchema,
  isLocalHttpEndpoint,
} from '@waleed/contracts';
import {
  createImportService,
  createLifecycle,
  emptyState,
  createCapabilityRuntime,
  createBindingResolver,
  definitionHash,
} from '@waleed/hub-core';
import {
  normalizeImport,
  clearImport,
} from '../packages/hub-core/src/imports/normalize.js';
import {
  restrictedFetch,
  safeMcpHttpTransport,
} from '../packages/hub-core/src/adapters/mcp/http.js';
import { addManualMcp } from '../packages/hub-core/src/integrations/manual.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from 'node:http';
import { mcpHttpFixture } from './helpers/mcp-http.js';
import { connector, profileState } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';
const dns = vi.hoisted(() => ({
  answer: null as Array<{ address: string; family: number }> | null,
}));
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    lookup: async (hostname: string) =>
      dns.answer ?? actual.lookup(hostname, { all: true, verbatim: true }),
  };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  dns.answer = null;
  for (const close of cleanups.splice(0).reverse()) await close();
});
it.each([
  'http://127.0.0.1:80',
  'http://127.0.0.1:3000/mcp',
  'http://localhost:65535/sse',
  'https://example.test/mcp',
])(
  'permits supported endpoint syntax %s but requires local consent on saved connectors',
  (endpoint) => {
    expect(EndpointSchema.safeParse(endpoint).success).toBe(true);
    const local = isLocalHttpEndpoint(endpoint),
      value = { ...connector('local'), endpoint };
    expect(ConnectorSchema.safeParse(value).success).toBe(!local);
    expect(
      ConnectorSchema.safeParse({ ...value, localHttpOptIn: true }).success,
    ).toBe(true);
  },
);
it.each([
  'http://127.0.0.1',
  'http://localhost/mcp',
  'http://localhost:0/mcp',
  'http://localhost:65536/mcp',
  'http://127.1:8080',
  'http://2130706433:8080',
  'http://0x7f000001:8080',
  'http://127.0.0.2:8080',
  'http://[::1]:8080',
  'http://localhost.evil.test:8080',
  'http://10.0.0.1:8080',
  'http://192.168.0.1:8080',
  'http://172.16.0.1:8080',
  'http://169.254.169.254:80',
  'http://example.test:8080',
  'http://user:pass@localhost:8080',
  'http://localhost:8080/?token=private',
  'http://localhost:8080/#private',
  'http://localhost:8080/?',
  ' http://localhost:8080',
  'http://localhost.:8080',
])(
  'rejects ambiguous, credential-bearing and non-loopback HTTP syntax %s',
  (endpoint) => {
    expect(EndpointSchema.safeParse(endpoint).success).toBe(false);
    expect(isLocalHttpEndpoint(endpoint)).toBe(false);
  },
);
it('normalizes local endpoints with a pending explicit opt-in and binds consent into execution approval', () => {
  const draft = normalizeImport(
    JSON.stringify({ url: 'http://localhost:8080/mcp' }),
  );
  try {
    expect(draft.entries[0]).toMatchObject({
      definition: null,
      warnings: expect.arrayContaining(['local_http_opt_in']),
      issues: [{ code: 'local_http_opt_in_required', field: 'localHttpOptIn' }],
    });
  } finally {
    clearImport(draft);
  }
  const value = connector('local');
  if (value.executionMode !== 'remote') throw new Error();
  value.endpoint = 'http://localhost:8080/mcp';
  value.localHttpOptIn = true;
  expect(definitionHash(value)).not.toBe(
    definitionHash({ ...value, localHttpOptIn: false }),
  );
});
it('cannot apply an unconfirmed local import; selection consent can be given and withdrawn explicitly', () => {
  const imports = createImportService(Date.now, true),
    state = emptyState();
  try {
    let preview = imports.preview(
      {
        source: JSON.stringify({ url: 'http://localhost:8080/mcp' }),
        expectedRevision: 0,
      },
      'owner',
      state,
      false,
    );
    expect(preview.selectionReady).toBe(false);
    expect(() => imports.take(preview.id, 'owner', state, false)).toThrow();
    const choose = (enabled: boolean) => ({
      expectedRevision: 0,
      entries: preview.entries.map((entry) => ({
        key: entry.key,
        name: entry.name,
        id: entry.id,
        selected: true,
        localHttpOptIn: enabled,
      })),
    });
    preview = imports.select(preview.id, choose(true), 'owner', state, false);
    expect(preview.selectionReady).toBe(true);
    expect(preview.entries[0]!.definition).toMatchObject({
      localHttpOptIn: true,
    });
    preview = imports.select(preview.id, choose(false), 'owner', state, false);
    expect(preview.selectionReady).toBe(false);
    expect(preview.entries[0]!.definition).toBeNull();
  } finally {
    imports.close();
  }
});
it('rejects direct local definition/manual saves without opt-in before registry or credential writes', async () => {
  const store = memoryStore(emptyState()),
    hub = createLifecycle(store);
  cleanups.push(() => hub.close());
  const input = {
    expectedRevision: 0,
    name: 'Local',
    type: 'streamable_http',
    url: 'http://localhost:8080/mcp',
    confirmSave: true,
    autoSync: false,
    approveExecution: false,
  };
  await expect(addManualMcp(hub, input, 'owner')).rejects.toBeDefined();
  expect((await store.read()).connectors).toEqual([]);
  expect(
    await addManualMcp(hub, { ...input, localHttpOptIn: true }, 'owner'),
  ).toMatchObject({ state: 'saved', requiresApproval: true });
  expect((await store.read()).connectors[0]).toMatchObject({
    localHttpOptIn: true,
    trustApproval: null,
  });
});
it.each([
  'http://10.0.0.1:8080',
  'http://192.168.0.1:8080',
  'http://172.16.0.1:8080',
  'http://169.254.169.254:80',
  'http://example.test:80',
  'https://127.0.0.1:8080',
])(
  'local opt-in never grants access to %s or leases credentials for it',
  async (endpoint) => {
    const credentials = vi.fn(async () => ({
      Authorization: 'SYNTHETIC-PRIVATE',
    }));
    await expect(
      restrictedFetch(
        endpoint,
        AbortSignal.timeout(1000),
        undefined,
        credentials,
        false,
        true,
      )(endpoint),
    ).rejects.toHaveProperty('reason', 'destination_denied');
    expect(credentials).not.toHaveBeenCalled();
  },
);
it.each(['127.0.0.1', 'localhost'])(
  'uses real opted-in HTTP at %s without a fixture exception and rejects redirects',
  async (hostname) => {
    const peer = await mcpHttpFixture();
    cleanups.push(peer.close);
    const base = peer.origin.replace('127.0.0.1', hostname),
      signal = AbortSignal.timeout(5000);
    await expect(
      restrictedFetch(base, signal)(`${base}/mcp`),
    ).rejects.toHaveProperty('reason', 'destination_denied');
    const response = await restrictedFetch(
      base,
      signal,
      undefined,
      {},
      false,
      true,
    )(`${base}/mcp`);
    expect(response.status).toBe(405);
    await response.body?.cancel();
    await expect(
      restrictedFetch(
        base,
        signal,
        undefined,
        {},
        false,
        true,
      )(`${base}/redirect`),
    ).rejects.toHaveProperty('reason', 'destination_denied');
    await expect(
      restrictedFetch(
        base,
        signal,
        undefined,
        {},
        false,
        true,
      )('http://169.254.169.254/private'),
    ).rejects.toHaveProperty('reason', 'destination_denied');
  },
);
it.each([
  [{ address: '10.1.2.3', family: 4 }],
  [
    { address: '127.0.0.1', family: 4 },
    { address: '192.168.1.2', family: 4 },
  ],
  [{ address: '::ffff:127.0.0.1', family: 6 }],
  [{ address: '8.8.8.8', family: 4 }],
])(
  'rejects rebinding/non-exact localhost resolution %j before credential access',
  async (...addresses) => {
    dns.answer = addresses;
    const credentials = vi.fn(async () => ({
      Authorization: 'SYNTHETIC-PRIVATE',
    }));
    await expect(
      restrictedFetch(
        'http://localhost:8080/mcp',
        AbortSignal.timeout(1000),
        undefined,
        credentials,
        false,
        true,
      )('http://localhost:8080/mcp'),
    ).rejects.toHaveProperty('reason', 'destination_denied');
    expect(credentials).not.toHaveBeenCalled();
  },
);
it.each(['streamable_http', 'sse'] as const)(
  'initializes opted-in local %s and clears protected credential buffers afterwards',
  async (transport) => {
    const secret = 'SYNTHETIC-LOCAL-PROTECTED-0123456789',
      peer = await mcpHttpFixture(`Bearer ${secret}`);
    cleanups.push(peer.close);
    const state = profileState(['remote']),
      value = state.connectors[0]!;
    if (value.executionMode !== 'remote') throw new Error();
    value.endpoint = `${peer.origin}/${transport === 'sse' ? 'sse' : 'mcp'}`;
    value.localHttpOptIn = true;
    const id = `wmh-secret-${crypto.randomUUID()}`;
    value.headerBindings.Authorization = id;
    value.credentialFormats = { Authorization: 'bearer' };
    value.trustApproval!.definitionHash = definitionHash(value);
    state.secretReferences = [
      {
        id,
        adapter: 'windows',
        present: true,
        ownerIds: [value.id],
        kind: 'credential',
      },
    ];
    const secrets = memorySecrets();
    cleanups.push(async () => secrets.close());
    const bytes = Buffer.from(secret);
    await secrets.backend.put(id, bytes, AbortSignal.timeout(1000));
    bytes.fill(0);
    const runtime = createCapabilityRuntime({
      workingDirectory: 'unused',
      resolveBindings: createBindingResolver(
        { windows: secrets.backend },
        async () => state,
      ),
    });
    const result = await runtime.discover(value, AbortSignal.timeout(5000));
    expect(result.protocolVersion).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(
      secrets.reads.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);
    expect(
      peer.methods.filter((method) => method === 'initialize'),
    ).toHaveLength(1);
  },
);
it('reuses an opted-in SSE transport for multiple catalog requests without reconnecting', async () => {
  const peer = await mcpHttpFixture();
  cleanups.push(peer.close);
  const client = new Client(
    { name: 'local-sse', version: '1' },
    { capabilities: {} },
  );
  const transport = safeMcpHttpTransport(
    `${peer.origin}/sse`,
    'sse',
    AbortSignal.timeout(5000),
    undefined,
    {},
    true,
  );
  try {
    await client.connect(transport);
    await client.listTools();
    await client.listTools();
    expect(
      peer.methods.filter((method) => method === 'initialize'),
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});
it('allows localhost pinned exclusively to ::1 when IPv6 loopback is available', async (context) => {
  const server = createServer((_request, response) => {
    response.end('local IPv6 response');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch (error) {
    if (
      ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    ) {
      context.skip();
      return;
    }
    throw error;
  }
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  dns.answer = [{ address: '::1', family: 6 }];
  const endpoint = `http://localhost:${address.port}/mcp`;
  const response = await restrictedFetch(
    endpoint,
    AbortSignal.timeout(5000),
    undefined,
    {},
    false,
    true,
  )(endpoint);
  expect(await response.text()).toBe('local IPv6 response');
});
it('rechecks and pins localhost DNS on every request rather than trusting the first resolution', async () => {
  const peer = await mcpHttpFixture();
  cleanups.push(peer.close);
  const endpoint = `${peer.origin.replace('127.0.0.1', 'localhost')}/mcp`,
    credentials = vi.fn(async () => ({}));
  const fetch = restrictedFetch(
    endpoint,
    AbortSignal.timeout(5000),
    undefined,
    credentials,
    false,
    true,
  );
  dns.answer = [{ address: '127.0.0.1', family: 4 }];
  const response = await fetch(endpoint);
  await response.body?.cancel();
  dns.answer = [{ address: '169.254.169.254', family: 4 }];
  await expect(fetch(endpoint)).rejects.toHaveProperty(
    'reason',
    'destination_denied',
  );
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(peer.headers).toHaveLength(1);
});
it('keeps an established local SSE session through a quiet period longer than the header timeout', async () => {
  const peer = await mcpHttpFixture();
  cleanups.push(peer.close);
  const client = new Client(
    { name: 'quiet-local-sse', version: '1' },
    { capabilities: {} },
  );
  try {
    await client.connect(
      safeMcpHttpTransport(
        `${peer.origin}/sse`,
        'sse',
        AbortSignal.timeout(12_000),
        undefined,
        {},
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5300));
    await client.listTools();
    expect(
      peer.methods.filter((method) => method === 'initialize'),
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
}, 15_000);
it('does not let local consent repair unrelated validation failures and clears private pending candidates on discard', () => {
  const secret = 'SYNTHETIC-PENDING-LOCAL-PRIVATE';
  const draft = normalizeImport(
    JSON.stringify({
      url: 'http://localhost:8080/mcp',
      headers: { Authorization: secret },
    }),
  );
  const buffers = [...draft.secrets.values()];
  expect(draft.entries[0]!.definition).toBeNull();
  expect(draft.pendingLocalHttp.size).toBe(1);
  expect(JSON.stringify(draft.entries)).not.toContain(secret);
  clearImport(draft);
  expect(draft.pendingLocalHttp.size).toBe(0);
  expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(
    true,
  );
  const service = createImportService(Date.now, true),
    state = emptyState();
  try {
    const preview = service.preview(
      {
        expectedRevision: 0,
        source: JSON.stringify({
          url: `http://localhost:8080/${secret}`,
          headers: { Authorization: secret },
        }),
      },
      'owner',
      state,
      false,
    );
    expect(preview.entries[0]!.definition).toBeNull();
    expect(preview.entries[0]!.localHttpEndpoint).toBeUndefined();
    expect(() =>
      service.select(
        preview.id,
        {
          expectedRevision: 0,
          entries: preview.entries.map((entry) => ({
            key: entry.key,
            id: entry.id,
            name: entry.name,
            selected: true,
            localHttpOptIn: true,
          })),
        },
        'owner',
        state,
        false,
      ),
    ).toThrow();
  } finally {
    service.close();
  }
});
