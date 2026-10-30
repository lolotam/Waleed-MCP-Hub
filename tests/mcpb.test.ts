import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  McpbManifestSchema,
  MCPB_MAX_ARCHIVE_BYTES,
  MCPB_MAX_UNCOMPRESSED_BYTES,
  type Connector,
} from '@waleed/contracts';
import {
  clearMcpb,
  createMcpbAdapter,
  inspectMcpb,
  resolveMcpbConfiguration,
  createLifecycle,
  createMemorySafetyLedger,
  emptyState,
  definitionHash,
} from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';
import { bundleManifest, mcpb, zip } from './helpers/mcpb.js';

const cleanups: Array<() => Promise<unknown>> = [];
it('revalidates extraction paths at the adapter seam before creating any directories', async () => {
  const f = await setup(),
    bundle = inspectMcpb(mcpb());
  try {
    bundle.files.set('../escape', Buffer.from('synthetic'));
    await expect(f.adapter.extract(bundle, randomUUID())).rejects.toThrow();
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    clearMcpb(bundle);
  }
});
it('rejects installed hardlinks and missing receipt files', async () => {
  const f = await setup(),
    preview = f.hub.bundles.preview(mcpb(), 'owner');
  await f.hub.bundles.install(
    preview.id,
    {
      expectedRevision: 0,
      configuration: { token: 'SYNTHETIC-LINK-TEST-PRIVATE' },
      confirmInstall: true,
    },
    'owner',
  );
  const connector = (await f.store.read()).connectors[0]!;
  if (connector.executionMode !== 'native') throw new Error();
  const path = join(
      f.adapter.path(connector.bundle!.id),
      'server',
      'index.mjs',
    ),
    alias = join(f.directory, 'alias.mjs');
  await link(path, alias);
  await expect(f.adapter.prepare(connector)).rejects.toThrow();
  await rm(alias);
  await rm(path);
  await expect(f.adapter.prepare(connector)).rejects.toThrow();
});
it('bounds implied directories as well as declared archive entries', () => {
  expect(() =>
    inspectMcpb(
      mcpb(
        undefined,
        Array.from({ length: 10 }, (_, index) => ({
          name: `tree${index}/` + 'a/'.repeat(60) + 'file',
          data: 'x',
        })),
      ),
    ),
  ).toThrow();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\mcpb-test-');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const secrets = memorySecrets();
  cleanups.push(async () => secrets.close());
  const store = memoryStore(emptyState()),
    adapter = createMcpbAdapter(directory, { node: process.execPath }),
    safety = createMemorySafetyLedger();
  const hub = createLifecycle(store, Date.now, safety, {
    secrets: { windows: secrets.backend },
    bundles: adapter,
  });
  cleanups.push(() => hub.close());
  return { directory, secrets, store, adapter, safety, hub };
}
it.each(['node', 'python', 'binary'] as const)(
  'validates direct %s manifests without executing them',
  (type) => {
    const manifest = bundleManifest();
    manifest.server.type = type;
    manifest.server.entry_point =
      type === 'node'
        ? 'server/index.mjs'
        : type === 'python'
          ? 'server/index.py'
          : 'server/server.exe';
    manifest.server.mcp_config.command =
      type === 'binary'
        ? '${__dirname}/server/server.exe'
        : type === 'python'
          ? 'python'
          : 'node';
    manifest.server.mcp_config.args =
      type === 'binary' ? [] : ['${__dirname}/' + manifest.server.entry_point];
    expect(McpbManifestSchema.safeParse(manifest).success).toBe(true);
  },
);
it.each([
  (m: ReturnType<typeof bundleManifest>) => {
    m.server.mcp_config.command = 'cmd.exe';
  },
  (m: ReturnType<typeof bundleManifest>) => {
    m.server.entry_point = '../x.mjs';
  },
  (m: ReturnType<typeof bundleManifest>) => {
    m.server.mcp_config.args = ['--eval', 'code'];
  },
  (m: ReturnType<typeof bundleManifest>) => {
    m.user_config!.token!.default = 'plaintext';
  },
  (m: ReturnType<typeof bundleManifest>) => {
    m.user_config!.count!.default = 'not a number';
  },
])('rejects unsupported manifest execution and configuration', (change) => {
  const manifest = bundleManifest();
  change(manifest);
  expect(McpbManifestSchema.safeParse(manifest).success).toBe(false);
});
it('rejects execution-affecting extensions instead of dropping them', () => {
  for (const server of [
    { ...bundleManifest().server, platforms: { win32: { command: 'evil' } } },
    {
      ...bundleManifest().server,
      mcp_config: { ...bundleManifest().server.mcp_config, cwd: 'elsewhere' },
    },
  ])
    expect(() => inspectMcpb(mcpb({ ...bundleManifest(), server }))).toThrow();
  expect(() =>
    inspectMcpb(
      mcpb({ ...bundleManifest(), compatibility: { platforms: ['darwin'] } }),
    ),
  ).toThrow();
});
it('bounds ZIP and total declared/uncompressed bytes and entry count', () => {
  expect(() => inspectMcpb(Buffer.alloc(MCPB_MAX_ARCHIVE_BYTES + 1))).toThrow();
  expect(() =>
    inspectMcpb(
      mcpb(undefined, [
        { name: 'huge', data: 'x', size: MCPB_MAX_UNCOMPRESSED_BYTES + 1 },
      ]),
    ),
  ).toThrow();
  expect(() =>
    inspectMcpb(
      mcpb(
        undefined,
        Array.from({ length: 499 }, (_, index) => ({ name: `file-${index}` })),
      ),
    ),
  ).toThrow();
  expect(() =>
    inspectMcpb(
      mcpb(undefined, [
        { name: 'understated', data: Buffer.alloc(1024 * 1024), size: 1 },
      ]),
    ),
  ).toThrow();
});
it.each([
  '../outside',
  'a/../outside',
  '/absolute',
  'C:/drive',
  'C:relative',
  '\\\\server\\share',
  'a\\..\\b',
  'a//b',
  './dot',
  'a/CON.txt',
  'a/aux',
  'a/COM¹',
  'a/CONOUT$',
  'file:stream',
  'a./x',
  'a /x',
  'a\0b',
  '..',
  '%invalid?',
])('rejects unsafe archive path %j', (name) =>
  expect(() => inspectMcpb(mcpb(undefined, [{ name }]))).toThrow(),
);
it('rejects symlinks, case collisions, file/directory conflicts, encryption and local/central disagreement', () => {
  for (const extra of [
    [{ name: 'symlink', attributes: 0xa1ff0000, data: 'outside' }],
    [{ name: 'MANIFEST.JSON', data: '{}' }],
    [
      { name: 'a', data: 'x' },
      { name: 'a/file', data: 'x' },
    ],
    [{ name: 'encrypted', flags: 0x801, data: 'x' }],
    [{ name: 'a', localName: 'b', data: 'x' }],
    [{ name: 'a', method: 99, data: 'x' }],
  ])
    expect(() => inspectMcpb(mcpb(undefined, extra))).toThrow();
});
it('rejects CRC corruption, missing manifest and missing entry point', () => {
  const archive = mcpb(),
    offset = 30 + Buffer.byteLength('manifest.json');
  archive[offset] = archive[offset]! ^ 255;
  expect(() => inspectMcpb(archive)).toThrow();
  expect(() => inspectMcpb(zip([{ name: 'other' }]))).toThrow();
  expect(() =>
    inspectMcpb(
      zip([{ name: 'manifest.json', data: JSON.stringify(bundleManifest()) }]),
    ),
  ).toThrow();
});
it('clears every extracted mutable buffer on discard', () => {
  const bundle = inspectMcpb(mcpb()),
    buffers = [...bundle.files.values()];
  clearMcpb(bundle);
  expect(buffers.every((bytes) => bytes.every((value) => value === 0))).toBe(
    true,
  );
  expect(bundle.files.size).toBe(0);
});
it.each(['NODE_OPTIONS', 'PATH', 'PYTHONPATH', 'WMH_REGISTRY'])(
  'rejects runtime-control environment %s before extraction',
  (key) => {
    const manifest = bundleManifest();
    manifest.server.mcp_config.env![key] = 'x';
    expect(() => inspectMcpb(mcpb(manifest))).toThrow();
  },
);
it('refuses sensitive args and unknown substitutions, and validates field values', () => {
  for (const token of [
    '${user_config.token}',
    '${user_config.missing}',
    '${HOME}',
  ]) {
    const manifest = bundleManifest();
    manifest.server.mcp_config.args!.push(token);
    expect(() => inspectMcpb(mcpb(manifest))).toThrow();
  }
  const bundle = inspectMcpb(mcpb());
  try {
    for (const configuration of [
      {},
      { token: 'synthetic', count: '3' },
      { token: 'synthetic', count: 20 },
      { token: 'synthetic', extra: 'bad' },
    ])
      expect(() =>
        resolveMcpbConfiguration(bundle, 'C:\\Synthetic', configuration),
      ).toThrow();
  } finally {
    clearMcpb(bundle);
  }
});
it('previews with no disk effects, installs protected configuration without executing, then verifies integrity', async () => {
  const f = await setup(),
    archive = mcpb(),
    secret = 'SYNTHETIC-MCPB-PRIVATE-TOKEN';
  const preview = f.hub.bundles.preview(archive, 'owner');
  expect(archive.every((value) => value === 0)).toBe(true);
  expect(await readdir(f.directory)).toEqual([]);
  expect(() => f.hub.bundles.cancel(preview.id, 'other')).toThrow();
  const input = {
    expectedRevision: 0,
    configuration: { token: secret, count: 4, enabled: true },
    confirmInstall: true,
  };
  const result = await f.hub.bundles.install(preview.id, input, 'owner');
  expect(result).toMatchObject({ state: 'saved', requiresApproval: true });
  expect(input.configuration.token).toBe('');
  const state = await f.store.read(),
    connector = state.connectors[0]!;
  expect(connector).toMatchObject({
    executionMode: 'native',
    trustApproval: null,
    secretBindings: {
      TOKEN: expect.any(String),
      COUNT: expect.any(String),
      ENABLED: expect.any(String),
    },
  });
  expect(
    JSON.stringify([state, preview, result, await f.safety.read()]),
  ).not.toContain(secret);
  expect(
    f.secrets.writes.every((buffer) => buffer.every((value) => value === 0)),
  ).toBe(true);
  if (connector.executionMode !== 'native') throw new Error();
  const launch = await f.adapter.prepare(connector);
  expect(launch.workingDirectory).toBe(f.adapter.path(connector.bundle!.id));
  expect(
    await readFile(join(launch.workingDirectory, 'manifest.json'), 'utf8'),
  ).not.toContain(secret);
  await writeFile(
    join(launch.workingDirectory, 'server', 'index.mjs'),
    'tampered',
  );
  await expect(f.adapter.prepare(connector)).rejects.toThrow();
});
it('binds the integrity receipt to execution approval', async () => {
  const f = await setup(),
    preview = f.hub.bundles.preview(mcpb(), 'owner');
  await f.hub.bundles.install(
    preview.id,
    {
      expectedRevision: 0,
      configuration: { token: 'SYNTHETIC-HASH-PRIVATE' },
      confirmInstall: true,
    },
    'owner',
  );
  const connector = (await f.store.read()).connectors[0]!;
  const before = definitionHash(connector);
  if (connector.executionMode === 'native')
    connector.bundle!.files[0]!.sha256 = '0'.repeat(64);
  expect(definitionHash(connector)).not.toBe(before);
});
it('does not materialize credentials if DPAPI is unavailable', async () => {
  const f = await setup(),
    hub = createLifecycle(f.store, Date.now, f.safety, { bundles: f.adapter });
  cleanups.push(() => hub.close());
  const preview = hub.bundles.preview(mcpb(), 'owner');
  await expect(
    hub.bundles.install(
      preview.id,
      {
        expectedRevision: 0,
        configuration: { token: 'SYNTHETIC-PROTECTION-PRIVATE' },
        confirmInstall: true,
      },
      'owner',
    ),
  ).rejects.toThrow();
  expect(await readdir(f.directory)).toEqual([]);
  expect((await f.store.read()).connectors).toEqual([]);
});
it('rolls back vault entries and extraction when registry commit fails', async () => {
  const f = await setup();
  f.store.write = vi.fn(async () => {
    throw new Error('synthetic failure');
  });
  const preview = f.hub.bundles.preview(mcpb(), 'owner');
  await expect(
    f.hub.bundles.install(
      preview.id,
      {
        expectedRevision: 0,
        configuration: { token: 'SYNTHETIC-ROLLBACK-PRIVATE' },
        confirmInstall: true,
      },
      'owner',
    ),
  ).rejects.toThrow();
  expect(f.secrets.values.size).toBe(0);
  expect(await readdir(join(f.directory, 'packages', 'bundles'))).toEqual([]);
  expect((await f.safety.read()).operations.at(-1)?.phase).toBe('aborted');
});
it('fails closed if an installed bundle contains an untracked file', async () => {
  const f = await setup(),
    bundle = inspectMcpb(mcpb()),
    id = randomUUID();
  const receipt = await f.adapter.extract(bundle, id);
  clearMcpb(bundle);
  const connector = {
    id: 'synthetic',
    name: 'Synthetic',
    description: '',
    executionMode: 'native',
    transport: 'stdio',
    enabled: true,
    revision: 1,
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    executable: process.execPath,
    arguments: [],
    bundle: receipt,
  } satisfies Extract<Connector, { executionMode: 'native' }>;
  await mkdir(join(f.adapter.path(id), 'extra'));
  await writeFile(join(f.adapter.path(id), 'extra', 'untracked'), 'x');
  await expect(f.adapter.prepare(connector)).rejects.toThrow();
});
it('accepts empty directory entries and rejects aliased parent casing', () => {
  const bundle = inspectMcpb(mcpb(undefined, [{ name: 'empty/' }]));
  clearMcpb(bundle);
  expect(() =>
    inspectMcpb(mcpb(undefined, [{ name: 'Server/other.mjs', data: 'x' }])),
  ).toThrow();
});
it('rejects stale inventory and clears configuration on every failure path', async () => {
  const f = await setup(),
    preview = f.hub.bundles.preview(mcpb(), 'owner'),
    input = {
      expectedRevision: 1,
      configuration: { token: 'SYNTHETIC-STALE-BUNDLE-PRIVATE' },
      confirmInstall: true,
    };
  await expect(
    f.hub.bundles.install(preview.id, input, 'owner'),
  ).rejects.toHaveProperty('code', 'conflict');
  expect(input.configuration.token).toBe('');
  expect(await readdir(f.directory)).toEqual([]);
});
it('bounds retained previews, discards them on logout, and expires them without writing files', async () => {
  const f = await setup();
  let now = 1000;
  const hub = createLifecycle(f.store, () => now, f.safety, {
    bundles: f.adapter,
  });
  cleanups.push(() => hub.close());
  const first = hub.bundles.preview(mcpb(), 'owner');
  hub.bundles.preview(mcpb(), 'other');
  expect(() => hub.bundles.preview(mcpb(), 'third')).toThrow();
  hub.bundles.revoke('owner');
  expect(() => hub.bundles.cancel(first.id, 'owner')).toThrow();
  now += 6 * 60_000;
  expect(() => hub.bundles.preview(mcpb(), 'third')).not.toThrow();
  expect(await readdir(f.directory)).toEqual([]);
});
it('clears buffers and cleans uncertain DPAPI writes after a proved registry non-commit', async () => {
  const f = await setup(),
    put = f.secrets.backend.put;
  f.secrets.backend.put = async (id, value, signal) => {
    await put(id, value, signal);
    throw new Error('failure after protected write');
  };
  const preview = f.hub.bundles.preview(mcpb(), 'owner');
  await expect(
    f.hub.bundles.install(
      preview.id,
      {
        expectedRevision: 0,
        configuration: { token: 'SYNTHETIC-UNCERTAIN-WRITE-PRIVATE' },
        confirmInstall: true,
      },
      'owner',
    ),
  ).rejects.toThrow();
  expect(f.secrets.values.size).toBe(0);
  expect(
    f.secrets.writes.every((bytes) => bytes.every((value) => value === 0)),
  ).toBe(true);
  expect((await f.safety.read()).operations.at(-1)?.phase).toBe('aborted');
});
it('proves a committed registry after an uncertain write instead of deleting live bundle credentials', async () => {
  const f = await setup(),
    write = f.store.write;
  f.store.write = async (revision, next) => {
    await write(revision, next);
    throw new Error('failure after registry commit');
  };
  const preview = f.hub.bundles.preview(mcpb(), 'owner'),
    result = await f.hub.bundles.install(
      preview.id,
      {
        expectedRevision: 0,
        configuration: { token: 'SYNTHETIC-UNCERTAIN-COMMIT-PRIVATE' },
        confirmInstall: true,
      },
      'owner',
    );
  expect(result.state).toBe('saved');
  expect(f.secrets.values.size).toBe(3);
  expect((await f.safety.read()).operations.at(-1)?.phase).toBe('committed');
});
it('blocks future writes if external rollback cannot be proved', async () => {
  const f = await setup();
  f.store.write = async () => {
    throw new Error('registry failure');
  };
  f.secrets.backend.delete = async () => {
    throw new Error('cleanup unavailable');
  };
  const preview = f.hub.bundles.preview(mcpb(), 'owner');
  await expect(
    f.hub.bundles.install(
      preview.id,
      {
        expectedRevision: 0,
        configuration: { token: 'SYNTHETIC-RECOVERY-BUNDLE-PRIVATE' },
        confirmInstall: true,
      },
      'owner',
    ),
  ).rejects.toThrow('recovery review');
  expect((await f.safety.read()).operations.at(-1)?.phase).toBe('needs_review');
  await expect(f.safety.assertWritable()).rejects.toThrow();
});
