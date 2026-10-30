import { afterEach, expect, it, vi } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsAgentTargets,
} from '@waleed/hub-core';
import { profileState } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';
import {
  parseAgentDocument,
  managedEntry,
} from '../packages/hub-core/src/integrations/formats.js';
import {
  readAgentServers,
  removeAgentServers,
} from '../packages/hub-core/src/integrations/adoption-formats.js';
import type { IntegrationAgentId } from '@waleed/contracts';
const secret = 'SYNTHETIC-ADOPTION-KEY-0123456789';
const hubs: Array<ReturnType<typeof createLifecycle>> = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
});
function setup(agentId: IntegrationAgentId = 'cursor', source?: string) {
  const target = windowsAgentTargets('C:\\Synthetic', {}).find(
    (item) => item.id === agentId,
  )!;
  const original =
    source ??
    (target.format === 'codex'
      ? `# Preserve header\nmodel = "keep-model"\n[mcp_servers.LocalOne]\ncommand = "npx"\nargs = ["-y", "synthetic-mcp@1.2.3"]\n[mcp_servers.LocalOne.env]\nPROVIDER_TOKEN = "${secret}"\n[tools]\nnode_repl = true\n`
      : `{// Preserve header\n"plugins":["keep"],"${target.format === 'vscode' ? 'servers' : target.format === 'opencode' ? 'mcp' : 'mcpServers'}":${target.format === 'opencode' ? '{"servers":' : ''}{"LocalOne":{"command":"npx","args":["-y","synthetic-mcp@1.2.3"],"env":{"PROVIDER_TOKEN":"${secret}"}}}${target.format === 'opencode' ? '}' : ''}}`);
  const contents = new Map([[target.paths[0]!, original]]),
    secrets = memorySecrets(),
    store = memoryStore(profileState([]));
  const files = {
    read: vi.fn(async (path: string) => contents.get(path) ?? null),
    replace: vi.fn(
      async (path: string, before: string | null, after: string) => {
        if ((contents.get(path) ?? null) !== before) throw new Error('drift');
        contents.set(path, after);
      },
    ),
    backup: vi.fn(async () => {
      throw new Error('Must not create plaintext backups.');
    }),
  };
  const safety = createMemorySafetyLedger();
  const hub = createLifecycle(store, Date.now, safety, {
    secrets: { windows: secrets.backend },
    integrations: {
      targets: [target],
      files,
      registry: 'C:\\Runtime\\state.json',
      node: 'C:\\Node\\node.exe',
      bridge: 'C:\\Hub\\bridge.js',
      discovery: {
        find: async () => [],
        read: async () => ({ status: 'missing' }),
        run: async () => {
          throw new Error('No execution');
        },
      },
    },
  });
  hubs.push(hub);
  return { hub, store, secrets, files, safety, contents, target, original };
}
const applyInput = {
  expectedRevision: 0,
  profileIds: ['profile'],
  confirmImport: true,
  confirmAgentConfigChange: true,
};
it.each(['claude-desktop', 'cursor', 'vscode', 'codex', 'opencode'] as const)(
  'imports %s entries, protects keys/recovery, binds profiles and preserves unrelated AST settings',
  async (agentId) => {
    const f = setup(agentId);
    const preview = await f.hub.adoption.preview(
      agentId,
      { expectedRevision: 0 },
      'owner',
    );
    expect(preview.applySupported).toBe(true);
    expect(preview.secretReferences).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain(secret);
    expect(f.secrets.values.size).toBe(0);
    expect(f.contents.get(f.target.paths[0]!)).toBe(f.original);
    const receipt = await f.hub.adoption.apply(preview.id, applyInput, 'owner');
    expect(receipt).toMatchObject({
      state: 'imported',
      revision: 1,
      requiresApproval: true,
      agentConfigurationChanged: true,
      processes: 0,
      networkRequests: 0,
    });
    const state = await f.hub.inventory(),
      connector = state.connectors[0]!;
    expect(connector).toMatchObject({
      executionMode: 'package',
      package: { manager: 'npm', name: 'synthetic-mcp', version: '1.2.3' },
      trustApproval: null,
    });
    expect(state.profiles[0]!.connectorIds).toEqual([connector.id]);
    expect(
      f.secrets.values
        .get(connector.secretBindings.PROVIDER_TOKEN!)!
        .toString(),
    ).toBe(secret);
    const result = f.contents.get(f.target.paths[0]!)!;
    expect(result).toContain('Preserve header');
    expect(result).not.toContain(secret);
    expect(result).not.toContain('synthetic-mcp@');
    expect(managedEntry(result, f.target.format)).toBeDefined();
    expect(f.files.backup).not.toHaveBeenCalled();
    const document = parseAgentDocument(result, f.target.format);
    if (agentId === 'codex') {
      expect(document.model).toBe('keep-model');
      expect(document.tools).toEqual({ node_repl: true });
    } else expect(document.plugins).toEqual(['keep']);
    const manifestId = receipt.encryptedRecoveryIds.at(-1)!;
    const manifest = JSON.parse(
      f.secrets.values.get(manifestId)!.toString(),
    ) as { chunks: string[] };
    expect(
      Buffer.concat(
        manifest.chunks.map((id) => f.secrets.values.get(id)!),
      ).toString(),
    ).toBe(f.original);
    expect(
      JSON.stringify([state, receipt, await f.safety.read()]),
    ).not.toContain(secret);
    expect(
      f.secrets.writes.every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
    await expect(
      f.hub.adoption.apply(
        preview.id,
        { ...applyInput, expectedRevision: 1 },
        'owner',
      ),
    ).rejects.toBeDefined();
  },
);
it('pins a formerly unpinned uvx configuration explicitly instead of installing latest', async () => {
  const f = setup(
    'cursor',
    JSON.stringify({
      mcpServers: {
        Python: { command: 'uvx', args: ['synthetic-mcp', '--mode', 'read'] },
      },
    }),
  );
  const preview = await f.hub.adoption.preview(
    'cursor',
    { expectedRevision: 0 },
    'owner',
  );
  expect(preview.entries[0]!.warnings).toContain('unpinned_package');
  const selected = f.hub.adoption.imports.select(
    preview.id,
    {
      expectedRevision: 0,
      entries: preview.entries.map((entry) => ({
        key: entry.key,
        name: entry.name,
        id: entry.id,
        selected: true,
        packageVersion: '1.2.3',
        entryPoint: 'synthetic-mcp',
      })),
    },
    'owner',
    await f.store.read(),
    false,
  );
  await f.hub.adoption.apply(selected.id, applyInput, 'owner');
  expect((await f.store.read()).connectors[0]).toMatchObject({
    executionMode: 'package',
    package: { manager: 'uvx', version: '1.2.3' },
    arguments: ['--mode', 'read'],
  });
});
it('applies pasted imports through the same protected transaction without writing agent configs', async () => {
  const f = setup();
  const preview = f.hub.adoption.imports.preview(
    {
      expectedRevision: 0,
      source: JSON.stringify({
        name: 'Remote',
        url: 'https://example.test/mcp',
        headers: { Authorization: `Bearer ${secret}` },
      }),
    },
    'owner',
    await f.store.read(),
    false,
  );
  const result = await f.hub.adoption.apply(
    preview.id,
    { ...applyInput, confirmAgentConfigChange: false },
    'owner',
  );
  expect(result.agentConfigurationChanged).toBe(false);
  expect(f.files.replace).not.toHaveBeenCalled();
  expect((await f.store.read()).connectors[0]).toMatchObject({
    credentialFormats: { Authorization: 'raw' },
    trustApproval: null,
  });
  expect(f.secrets.values.size).toBe(1);
});
it('refuses stale source, wrong owner, absent consent and duplicate names before any credential writes', async () => {
  const f = setup(),
    preview = await f.hub.adoption.preview(
      'cursor',
      { expectedRevision: 0 },
      'owner',
    );
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'other'),
  ).rejects.toHaveProperty('code', 'not_found');
  await expect(
    f.hub.adoption.apply(
      preview.id,
      { ...applyInput, confirmAgentConfigChange: false },
      'owner',
    ),
  ).rejects.toHaveProperty('code', 'invalid');
  f.contents.set(f.target.paths[0]!, f.original + '\n// external edit');
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).rejects.toHaveProperty('code', 'conflict');
  expect(f.secrets.values.size).toBe(0);
  expect(f.files.replace).not.toHaveBeenCalled();
});
it('retains encrypted recovery and clears buffers on an ambiguous vault write failure before config replacement', async () => {
  const f = setup(),
    preview = await f.hub.adoption.preview(
      'cursor',
      { expectedRevision: 0 },
      'owner',
    );
  const put = f.secrets.backend.put;
  let writes = 0;
  f.secrets.backend.put = async (...args) => {
    await put(...args);
    if (++writes === 2) throw new Error('SYNTHETIC-PRIVATE-FAILURE');
  };
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).rejects.toHaveProperty('code', 'unavailable');
  expect(f.secrets.values.size).toBeGreaterThan(0);
  expect((await f.store.read()).revision).toBe(0);
  expect(f.contents.get(f.target.paths[0]!)).toBe(f.original);
  expect((await f.safety.read()).operations[0]!.phase).toBe('needs_review');
  expect(
    f.secrets.writes.every((value) => value.every((byte) => byte === 0)),
  ).toBe(true);
});
it('retains encrypted recovery and blocks retries on uncertain post-config registry commit failure', async () => {
  const f = setup(),
    preview = await f.hub.adoption.preview(
      'cursor',
      { expectedRevision: 0 },
      'owner',
    );
  f.store.write = async () => {
    throw new Error('storage failure');
  };
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).rejects.toHaveProperty('code', 'unavailable');
  expect(f.contents.get(f.target.paths[0]!)).not.toContain(secret);
  expect(f.secrets.values.size).toBeGreaterThan(1);
  expect((await f.safety.read()).operations[0]!.phase).toBe('needs_review');
  await expect(
    f.hub.adoption.preview('cursor', { expectedRevision: 0 }, 'owner'),
  ).rejects.toHaveProperty('code', 'conflict');
  expect(JSON.stringify(await f.safety.read())).not.toContain(secret);
});
it('refuses to leave duplicate selected credentials in unrelated config or comments', async () => {
  const f = setup();
  f.contents.set(f.target.paths[0]!, f.original + `\n// ${secret}`);
  const preview = await f.hub.adoption.preview(
    'cursor',
    { expectedRevision: 0 },
    'owner',
  );
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).rejects.toHaveProperty('code', 'invalid');
  expect(f.secrets.values.size).toBe(0);
  expect(f.files.replace).not.toHaveBeenCalled();
});
it('removes quoted and nested TOML tables without touching unselected entries or comments', () => {
  const source = `# keep\nmodel = 'x'\n[mcp_servers."a.b"]\ncommand = 'npx'\nargs = ['pkg@1.2.3']\n[mcp_servers."a.b".env]\nTOKEN = 'private'\n# remaining\n[mcp_servers.keep]\ncommand = 'stay'\n`;
  expect(readAgentServers(source, 'codex').keys).toEqual(['a.b', 'keep']);
  const result = removeAgentServers(source, 'codex', ['a.b']);
  expect(result).not.toContain('private');
  expect(result).toContain("command = 'stay'");
  expect(result).toContain('# remaining');
  expect(result).toContain('# keep');
});
it('rejects duplicate JSON keys, unresolved environment substitutions and unsupported inline executables', async () => {
  const f = setup(
    'cursor',
    '{"mcpServers":{"a":{"command":"npx"},"a":{"command":"uvx"}}}',
  );
  await expect(
    f.hub.adoption.preview('cursor', { expectedRevision: 0 }, 'owner'),
  ).rejects.toBeDefined();
  f.contents.set(
    f.target.paths[0]!,
    JSON.stringify({
      mcpServers: {
        One: {
          command: 'npx',
          args: ['pkg@1.2.3'],
          env: { TOKEN: '${MISSING}' },
        },
      },
    }),
  );
  const preview = await f.hub.adoption.preview(
    'cursor',
    { expectedRevision: 0 },
    'owner',
  );
  expect(preview.selectionReady).toBe(false);
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).rejects.toHaveProperty('code', 'conflict');
  expect(f.secrets.values.size).toBe(0);
});

it.each(
  [
    ['a'],
    ['b'],
    ['c'],
    ['a', 'b'],
    ['b', 'c'],
    ['a', 'c'],
    ['a', 'b', 'c'],
  ].map((names) => ({ names })),
)(
  'losslessly removes inline TOML entries $names without comma corruption',
  ({ names }) => {
    const source =
      "# keep-inline\nmodel = 'stay'\nmcp_servers = { a = { command = 'one' }, b = { command = 'two' }, c = { command = 'three' } }\n";
    const result = removeAgentServers(source, 'codex', names);
    const doc = parseAgentDocument(result, 'codex');
    expect(doc.model).toBe('stay');
    expect(result).toContain('# keep-inline');
    expect(Object.keys((doc.mcp_servers ?? {}) as object)).toEqual(
      ['a', 'b', 'c'].filter((name) => !names.includes(name)),
    );
  },
);
it('cleans only proven owned writes when protected read-back fails before source replacement', async () => {
  const f = setup(),
    preview = await f.hub.adoption.preview(
      'cursor',
      { expectedRevision: 0 },
      'owner',
    );
  const has = f.secrets.backend.has;
  let failed = false;
  f.secrets.backend.has = async (id, signal) => {
    if (f.secrets.values.has(id) && !failed) {
      failed = true;
      return false;
    }
    return has(id, signal);
  };
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).rejects.toHaveProperty('code', 'unavailable');
  expect(f.secrets.values.size).toBe(0);
  expect(f.contents.get(f.target.paths[0]!)).toBe(f.original);
  expect((await f.safety.read()).operations[0]!.phase).toBe('aborted');
});
it('recognizes a successful registry commit after a reported storage failure instead of duplicating an import', async () => {
  const f = setup(),
    preview = await f.hub.adoption.preview(
      'cursor',
      { expectedRevision: 0 },
      'owner',
    );
  const write = f.store.write;
  f.store.write = async (...args) => {
    await write(...args);
    throw new Error('post-commit failure');
  };
  expect(
    await f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).toMatchObject({ state: 'imported', revision: 1 });
  expect((await f.store.read()).connectors).toHaveLength(1);
  expect((await f.safety.read()).operations[0]!.phase).toBe('committed');
});
it('rejects escaped duplicate credentials in unselected JSON fields as well as raw comments', async () => {
  const value = 'SYNTHETIC-escaped-"-backslash-\\-value';
  const f = setup(
    'cursor',
    JSON.stringify({
      mcpServers: {
        Selected: {
          command: 'npx',
          args: ['pkg@1.2.3'],
          env: { TOKEN: value },
        },
      },
      unrelated: { credential: value },
    }),
  );
  const preview = await f.hub.adoption.preview(
    'cursor',
    { expectedRevision: 0 },
    'owner',
  );
  await expect(
    f.hub.adoption.apply(preview.id, applyInput, 'owner'),
  ).rejects.toHaveProperty('code', 'invalid');
  expect(f.files.replace).not.toHaveBeenCalled();
  expect(f.secrets.values.size).toBe(0);
});
