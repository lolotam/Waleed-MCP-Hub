import { expect, it, vi } from 'vitest';
import { createLifecycle, createMemorySafetyLedger } from '@waleed/hub-core';
import type { IntegrationAdapters } from '../packages/hub-core/src/integrations/engine.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';
import { createHubServer } from '../apps/server/src/app.js';
import { createAgentCloning } from '../packages/hub-core/src/integrations/cloning.js';
import { HubError } from '@waleed/hub-core';
import type { PackageJob, PackagePreview } from '@waleed/contracts';
import type { PackageService } from '../packages/hub-core/src/packages/service.js';
import { definition, profileState } from './helpers/runtime.js';

const secret = 'SYNTHETIC_CLONE_TOKEN_123456789';
function fixture() {
  const files = new Map([
    [
      'C:\\agents\\claude.json',
      JSON.stringify({
        mcpServers: {
          first: {
            url: 'https://example.test/mcp',
            headers: { Authorization: `Bearer ${secret}` },
          },
          second: {
            command: 'npx',
            args: ['-y', 'synthetic-mcp@1.2.3'],
            env: { API_KEY: secret },
          },
          'waleed-mcp-hub': { command: 'node', args: ['bridge.js'] },
        },
      }),
    ],
    [
      'C:\\agents\\codex.toml',
      '[mcp_servers.third]\nurl="https://example.test/third"\n',
    ],
  ]);
  const secrets = memorySecrets();
  const adapters: IntegrationAdapters = {
    targets: [
      {
        id: 'claude',
        name: 'Claude Code',
        paths: ['C:\\agents\\claude.json'],
        format: 'mcpServers',
        aliases: ['claude'],
        reconnect: 'Reconnect',
      },
      {
        id: 'codex',
        name: 'Codex',
        paths: ['C:\\agents\\codex.toml'],
        format: 'codex',
        aliases: ['codex'],
        reconnect: 'Reconnect',
      },
    ],
    files: {
      read: vi.fn(async (path) => files.get(path) ?? null),
      replace: vi.fn(async () => {}),
      backup: vi.fn(async () => 'backup'),
    },
    discovery: {
      find: vi.fn(async () => []),
      read: vi.fn(async () => ({ status: 'missing' as const })),
      run: vi.fn(async () => ({ ok: false, output: '' })),
    },
    node: 'C:\\runtime\\node.exe',
    registry: 'C:\\hub\\state.json',
  };
  const hub = createLifecycle(
    memoryStore(),
    Date.now,
    createMemorySafetyLedger(),
    { integrations: adapters, secrets: { windows: secrets.backend } },
  );
  return { hub, files, secrets, adapters };
}
async function finished(f: ReturnType<typeof fixture>, id: string) {
  await expect
    .poll(() => f.hub.cloning!.job(id, 'owner').state)
    .not.toMatch(/^(queued|running)$/);
  return f.hub.cloning!.job(id, 'owner');
}
it('groups sanitized candidates by agent, omits the Hub and copies only selected entries with exact protected credentials', async () => {
  const f = fixture(),
    before = new Map(f.files);
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    expect(scan.agents.map((item) => item.agentId)).toEqual([
      'claude',
      'codex',
    ]);
    expect(scan.candidates).toHaveLength(3);
    expect(JSON.stringify(scan)).not.toContain(secret);
    const candidate = scan.candidates.find((item) => item.name === 'first')!;
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        approveExecution: true,
        copyCredentials: true,
        entries: [{ key: candidate.key, name: 'Copied first' }],
      },
      'owner',
    );
    const result = await finished(f, scan.id);
    expect(result.results[0]!.state).toBe('saved');
    const state = await f.hub.inventory();
    expect(state.connectors).toHaveLength(1);
    expect(state.connectors[0]!.name).toBe('Copied first');
    expect(state.connectors[0]!.trustApproval).not.toBeNull();
    expect(
      [...f.secrets.values.values()].map((value) => value.toString()),
    ).toEqual([`Bearer ${secret}`]);
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(f.files).toEqual(before);
    expect(f.adapters.files.replace).not.toHaveBeenCalled();
    expect(f.adapters.discovery.run).not.toHaveBeenCalled();
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});
it('rejects source drift before any definition or credential is saved', async () => {
  const f = fixture();
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    f.files.set('C:\\agents\\claude.json', '{}');
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        approveExecution: true,
        copyCredentials: true,
        entries: [{ key: scan.candidates[0]!.key, name: 'first' }],
      },
      'owner',
    );
    expect((await finished(f, scan.id)).reason).toBe('source_changed');
    expect((await f.hub.inventory()).revision).toBe(0);
    expect(f.secrets.values.size).toBe(0);
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});
it('keeps a saved definition repairable after credential storage fails and refuses replay as a new copy', async () => {
  const f = fixture();
  f.secrets.backend.put = async () => {
    throw new Error('synthetic backend failure');
  };
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    const input = {
      expectedRevision: 0,
      approveExecution: true,
      copyCredentials: true,
      entries: [{ key: scan.candidates[0]!.key, name: 'partial' }],
    };
    f.hub.cloning!.copy(scan.id, input, 'owner');
    const result = await finished(f, scan.id);
    expect(result.results[0]).toMatchObject({ state: 'partially_saved' });
    expect(result.results[0]!.connectorId).toBeTruthy();
    expect((await f.hub.inventory()).connectors).toHaveLength(1);
    expect(() => f.hub.cloning!.copy(scan.id, input, 'owner')).toThrow(
      /already saved/,
    );
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});
it('requires the reviewed package preview and explicit entry/warnings before installing npx sources', async () => {
  const f = fixture();
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    const candidate = scan.candidates.find((item) => item.state === 'package')!;
    expect(candidate.packageProposal?.name).toBe('synthetic-mcp');
    expect(() =>
      f.hub.cloning!.copy(
        scan.id,
        {
          expectedRevision: 0,
          approveExecution: true,
          copyCredentials: true,
          entries: [{ key: candidate.key, name: 'package' }],
        },
        'owner',
      ),
    ).toThrow(/Review the resolved package/);
    expect((await f.hub.inventory()).revision).toBe(0);
    expect(() => f.hub.cloning!.job(scan.id, 'other')).toThrow(/expired/);
    f.hub.cloning!.revoke('owner');
    expect(() => f.hub.cloning!.job(scan.id, 'owner')).toThrow(/expired/);
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});
it('requires session and CSRF, rejects caller-supplied scan paths and scopes jobs to their owner', async () => {
  const f = fixture(),
    server = await createHubServer({ port: 4177, lifecycle: f.hub });
  const host = '127.0.0.1:4177',
    origin = `http://${host}`;
  const login = async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token: server.issueLaunchToken() },
    });
    return {
      host,
      origin,
      cookie: String(response.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': response.json().csrfToken,
    };
  };
  try {
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/agent-cloning/scan',
          headers: { host, origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const headers = await login();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/agent-cloning/scan',
          headers: { host, origin, cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/agent-cloning/scan',
          headers,
          payload: { path: 'C:\\private' },
        })
      ).statusCode,
    ).toBe(400);
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/agent-cloning/scan',
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const other = await login();
    expect(
      (
        await server.app.inject({
          url: `/api/agent-cloning/${response.json().id}`,
          headers: other,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await server.app.close();
    f.secrets.close();
  }
});

it('retains saved outcomes across later copies so partial/successful entries cannot be replayed', async () => {
  const f = fixture();
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    const first = scan.candidates.find((item) => item.name === 'first')!,
      third = scan.candidates.find((item) => item.name === 'third')!;
    for (const candidate of [first, third]) {
      f.hub.cloning!.copy(
        scan.id,
        {
          expectedRevision: (await f.hub.inventory()).revision,
          copyCredentials: true,
          approveExecution: true,
          entries: [{ key: candidate.key, name: candidate.name }],
        },
        'owner',
      );
      await finished(f, scan.id);
    }
    expect(f.hub.cloning!.job(scan.id, 'owner').results).toHaveLength(2);
    expect(() =>
      f.hub.cloning!.copy(
        scan.id,
        {
          expectedRevision: 0,
          copyCredentials: true,
          approveExecution: true,
          entries: [{ key: first.key, name: 'duplicate' }],
        },
        'owner',
      ),
    ).toThrow(/already saved/);
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});
it('preserves nested remote credentials and disabled state', async () => {
  const f = fixture();
  f.files.set(
    'C:\\agents\\claude.json',
    JSON.stringify({
      mcpServers: {
        nested: {
          enabled: false,
          remote: {
            url: 'https://example.test/mcp',
            headers: { Authorization: secret },
          },
        },
      },
    }),
  );
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id),
      candidate = scan.candidates.find((item) => item.name === 'nested')!;
    expect(candidate.credentialCount).toBe(1);
    expect(candidate.enabled).toBe(false);
    expect(JSON.stringify(scan)).not.toContain(secret);
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        copyCredentials: true,
        approveExecution: true,
        entries: [{ key: candidate.key, name: 'nested' }],
      },
      'owner',
    );
    await finished(f, scan.id);
    const connector = (await f.hub.inventory()).connectors[0]!;
    expect(connector.enabled).toBe(false);
    expect(connector.trustApproval).toBeNull();
    expect([...f.secrets.values.values()][0]!.toString()).toBe(secret);
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});
it('keeps unsupported large credential maps readable and missing references repairable', async () => {
  const f = fixture();
  f.files.set(
    'C:\\agents\\claude.json',
    JSON.stringify({
      mcpServers: {
        tooMany: {
          command: 'tool',
          env: Object.fromEntries(
            Array.from({ length: 129 }, (_, i) => [`KEY_${i}`, secret]),
          ),
        },
        missing: {
          url: 'https://example.test/mcp',
          headers: { Authorization: '${input:auth}' },
        },
      },
    }),
  );
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    expect(scan.candidates.some((item) => item.state === 'needs_setup')).toBe(
      true,
    );
    const candidate = scan.candidates.find((item) => item.name === 'missing')!;
    expect(candidate.state).toBe('ready');
    expect(candidate.missing).toEqual(['Authorization']);
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        copyCredentials: true,
        approveExecution: true,
        entries: [{ key: candidate.key, name: 'missing' }],
      },
      'owner',
    );
    expect((await finished(f, scan.id)).results[0]!.state).toBe('saved');
    expect((await f.hub.inventory()).connectors[0]!.description).toContain(
      'Authorization',
    );
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});
it('waits through package commit cancellation and preserves the committed connector for repair', async () => {
  const f = fixture();
  let installedId: string | null = null;
  let release: () => void = () => {};
  const preview: PackagePreview = {
    previewId: '00000000-0000-4000-8000-000000000001',
    name: 'synthetic-mcp',
    version: '1.2.3',
    description: null,
    integrity: `sha512-${'A'.repeat(86)}==`,
    lockHash: 'a'.repeat(64),
    packageCount: 1,
    bundledCount: 0,
    unpackedSize: 100,
    releasedAt: null,
    entries: [{ entry: 'serve', entryPath: 'server.js' }],
    warnings: ['large_size'],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const job: PackageJob = {
    id: '00000000-0000-4000-8000-000000000002',
    kind: 'install',
    state: 'running',
    createdAt: new Date().toISOString(),
    completedAt: null,
    phase: 'saving',
    progress: { downloadedBytes: 100, packages: 1 },
    error: null,
    preview: null,
    result: null,
  };
  const packages = {
    resolve: () => ({ ...job, kind: 'resolve', state: 'succeeded', preview }),
    install: async (input: { connectorName: string }) => {
      const state = await f.hub.inventory();
      const p = await f.hub.preview(
        {
          kind: 'create_connector',
          expectedRevision: state.revision,
          definition: definition({
            id: 'saved-package',
            name: input.connectorName,
            command: 'C:\\Synthetic\\node.exe',
            args: ['server.js'],
          }),
        },
        'owner',
      );
      await f.hub.apply(p.id, 'owner');
      await f.hub.drain();
      installedId = 'saved-package';
      release = () => {
        job.state = 'succeeded';
        job.result = { connectorId: installedId!, outcome: 'saved' };
      };
      return job;
    },
    job: vi.fn(() => job),
    cancel: vi.fn(() => {
      throw new HubError('busy', 'Already committing.');
    }),
  } as unknown as PackageService;
  const service = createAgentCloning({ ...f.hub, packages }, f.adapters);
  const done = async (id: string) => {
    await expect
      .poll(() => service.job(id, 'owner').state)
      .not.toMatch(/^(queued|running)$/);
    return service.job(id, 'owner');
  };
  try {
    const scan = await done(service.scan('owner').id),
      candidate = scan.candidates.find((item) => item.state === 'package')!;
    service.prepare(scan.id, [candidate.key], 'owner');
    await done(scan.id);
    expect(() =>
      service.copy(
        scan.id,
        {
          expectedRevision: 0,
          copyCredentials: true,
          approveExecution: true,
          entries: [{ key: candidate.key, name: 'pkg', entry: 'serve' }],
        },
        'owner',
      ),
    ).toThrow(/every warning/);
    service.copy(
      scan.id,
      {
        expectedRevision: 0,
        copyCredentials: true,
        approveExecution: true,
        entries: [
          {
            key: candidate.key,
            name: 'pkg',
            entry: 'serve',
            acknowledgedWarnings: ['large_size'],
          },
        ],
      },
      'owner',
    );
    await expect.poll(() => packages.job).toBeTruthy();
    await expect.poll(() => installedId).toBe('saved-package');
    await expect
      .poll(() => vi.mocked(packages.job).mock.calls.length)
      .toBeGreaterThan(0);
    expect(() => service.cancel(scan.id, 'owner')).not.toThrow();
    release();
    const result = await done(scan.id);
    expect(result.state).toBe('cancelled');
    expect(result.results[0]).toMatchObject({
      connectorId: 'saved-package',
      state: 'partially_saved',
    });
    expect((await f.hub.inventory()).connectors).toHaveLength(1);
  } finally {
    release();
    await service.close();
    await f.hub.close();
    f.secrets.close();
  }
});

it('ignores unrelated agent settings changes while binding the exact selected MCP', async () => {
  const f = fixture();
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    const key = scan.candidates.find((item) => item.name === 'first')!.key;
    const path = 'C:\\agents\\claude.json';
    const source = JSON.parse(f.files.get(path)!);
    source.windowStatistics = { opened: 42 };
    f.files.set(path, JSON.stringify(source));
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        copyCredentials: true,
        approveExecution: true,
        entries: [{ key, name: 'first' }],
      },
      'owner',
    );
    expect((await finished(f, scan.id)).results[0]!.state).toBe('saved');
    expect(JSON.parse(f.files.get(path)!).windowStatistics.opened).toBe(42);
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});

it('cancels during native executable lookup before any definition or credentials are saved', async () => {
  const f = fixture();
  let release: () => void = () => {};
  let looking = false;
  f.files.set(
    'C:\\agents\\claude.json',
    JSON.stringify({
      mcpServers: {
        native: {
          command: 'node',
          args: ['script.js'],
          env: { API_KEY: secret },
        },
      },
    }),
  );
  f.adapters.discovery.find = async () => {
    looking = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return [];
  };
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id),
      candidate = scan.candidates.find((item) => item.name === 'native')!;
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        copyCredentials: true,
        approveExecution: true,
        entries: [{ key: candidate.key, name: 'native' }],
      },
      'owner',
    );
    await expect.poll(() => looking).toBe(true);
    f.hub.cloning!.cancel(scan.id, 'owner');
    release();
    expect((await finished(f, scan.id)).state).toBe('cancelled');
    expect((await f.hub.inventory()).connectors).toEqual([]);
    expect(f.secrets.values.size).toBe(0);
  } finally {
    release();
    await f.hub.close();
    f.secrets.close();
  }
});
it('keeps a partially written direct copy unapproved when cancellation arrives during credential storage', async () => {
  const f = fixture();
  let release: () => void = () => {};
  let writing = false;
  const original = f.secrets.backend.put.bind(f.secrets.backend);
  f.secrets.backend.put = async (id, value, signal) => {
    writing = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await original(id, value, signal);
  };
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id),
      candidate = scan.candidates.find((item) => item.name === 'first')!;
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        copyCredentials: true,
        approveExecution: true,
        entries: [{ key: candidate.key, name: 'first' }],
      },
      'owner',
    );
    await expect.poll(() => writing).toBe(true);
    f.hub.cloning!.cancel(scan.id, 'owner');
    release();
    const result = await finished(f, scan.id);
    expect(result.results[0]!.state).toBe('partially_saved');
    expect(result.results[0]!.connectorId).toBeTruthy();
    expect((await f.hub.inventory()).connectors[0]!.trustApproval).toBeNull();
  } finally {
    release();
    await f.hub.close();
    f.secrets.close();
  }
});

it('redacts credential echoes from a sibling entry even when entries are normalized separately', async () => {
  const f = fixture();
  f.files.set(
    'C:\\agents\\claude.json',
    JSON.stringify({
      mcpServers: {
        leaker: { command: 'C:\\Trusted\\tool.exe', args: [secret] },
        holder: {
          url: 'https://example.test/mcp',
          http_headers: { Authorization: secret },
        },
      },
    }),
  );
  try {
    const scan = await finished(f, f.hub.cloning!.scan('owner').id);
    expect(JSON.stringify(scan)).not.toContain(secret);
    expect(scan.candidates.find((item) => item.name === 'leaker')!.state).toBe(
      'needs_setup',
    );
  } finally {
    await f.hub.close();
    f.secrets.close();
  }
});

it('does not wait for unrelated capability checks when copying a connector', async () => {
  const f = fixture();
  await f.hub.close();
  let release: () => void = () => {};
  f.hub = createLifecycle(
    memoryStore(profileState(['native'])),
    Date.now,
    createMemorySafetyLedger(),
    {
      integrations: f.adapters,
      secrets: { windows: f.secrets.backend },
      runtime: {
        async discover() {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            protocolVersion: '2025-11-25',
            tools: [],
            resourceCount: 0,
            promptCount: 0,
          };
        },
      },
    },
  );
  try {
    const check = await f.hub.checks.start('connector-0', 'owner');
    const scan = await finished(f, f.hub.cloning!.scan('owner').id),
      candidate = scan.candidates.find((item) => item.name === 'first')!;
    f.hub.cloning!.copy(
      scan.id,
      {
        expectedRevision: 0,
        copyCredentials: true,
        approveExecution: true,
        entries: [{ key: candidate.key, name: 'first' }],
      },
      'owner',
    );
    expect((await finished(f, scan.id)).results[0]!.state).toBe('saved');
    expect(f.hub.checks.job(check.id, 'owner').state).toBe('running');
  } finally {
    release();
    await f.hub.close();
    f.secrets.close();
  }
});
