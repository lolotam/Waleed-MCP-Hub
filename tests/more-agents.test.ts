import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  IntegrationAgentIdSchema,
  AgentProfileBindingsSchema,
  AgentToolSearchModesSchema,
  AgentToolSetsSchema,
  StateSchema,
} from '@waleed/contracts';
import { createAgentBridge, windowsAgentTargets } from '@waleed/hub-core';
import {
  agentEntry,
  editAgentDocument,
  managedEntry,
  parseAgentDocument,
} from '../packages/hub-core/src/integrations/formats.js';
import { hashData } from '../packages/hub-core/src/runtime/registry.js';
import { agentFiles } from '../packages/hub-core/src/integrations/files.js';
import {
  newAgentIds,
  moreAgentsFixture,
  agentSource,
} from './helpers/more-agents.js';
import { playgroundFixture } from './helpers/playground.js';
import { agentPresentation } from '../apps/web/src/Icon.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const f = moreAgentsFixture();
  cleanup.push(f.close);
  return f;
}
it('supports exactly 17 unique targets and complete presentation/profile/search contracts', async () => {
  const f = fixture();
  expect(f.targets).toHaveLength(17);
  expect(IntegrationAgentIdSchema.options).toHaveLength(17);
  expect(new Set(f.targets.map((target) => target.id))).toEqual(
    new Set(IntegrationAgentIdSchema.options),
  );
  const state = await f.hub.inventory();
  state.agentProfileBindings = Object.fromEntries(
    IntegrationAgentIdSchema.options.map((id) => [id, 'profile']),
  );
  state.agentToolSearchModes = Object.fromEntries(
    IntegrationAgentIdSchema.options.map((id) => [id, true]),
  );
  expect(AgentProfileBindingsSchema.parse(state.agentProfileBindings)).toEqual(
    state.agentProfileBindings,
  );
  expect(AgentToolSearchModesSchema.parse(state.agentToolSearchModes)).toEqual(
    state.agentToolSearchModes,
  );
  StateSchema.parse(state);
  expect(
    AgentToolSetsSchema.parse(await f.hub.integrations.toolSets()).toolSets,
  ).toHaveLength(17);
  for (const id of IntegrationAgentIdSchema.options)
    expect(agentPresentation[id]).toHaveProperty('icon');
});
it.each(newAgentIds)(
  '%s losslessly integrates/disconnects with backups and a bridge argv pinned to its agent identity',
  async (id) => {
    const f = fixture(),
      target = f.targets.find((target) => target.id === id)!,
      original = agentSource(target),
      scan = await f.hub.integrations.scan(),
      agent = scan.agents.find((agent) => agent.agentId === id)!;
    expect(agent).toMatchObject({ detected: true, status: 'not_integrated' });
    expect(JSON.stringify(scan)).not.toContain('SYNTHETIC-EXISTING-PRIVATE');
    const receipt = await f.hub.integrations.integrate(id, {
      expectedRevision: 0,
      fingerprint: agent.fingerprint,
      confirmConfigurationChange: true,
    });
    expect(receipt.agent.status).toBe('integrated');
    expect(f.backups[0]).toEqual({ agent: id, text: original });
    const written = f.contents.get(agent.configPath)!,
      entry = managedEntry(written, target.format) as { args: string[] };
    expect(entry.args).toEqual([
      'C:\\SyntheticHub\\bridge.js',
      'C:\\SyntheticMoreAgents\\state.json',
      id,
    ]);
    expect(written).toContain('Keep provider');
    expect(written).toContain('SYNTHETIC-EXISTING-PRIVATE');
    if (id === 'goose') {
      expect(written).toContain('GOOSE_MODE: approve');
      expect(written).toContain('  developer:\n    type: builtin');
      expect(written).toContain('# keep footer');
    } else expect(written).toContain('"approval": "ask"');
    const fresh = await f.hub.integrations.status(id);
    await f.hub.integrations.disconnect(id, {
      expectedRevision: 1,
      fingerprint: fresh.fingerprint,
      confirmConfigurationChange: true,
    });
    expect(
      managedEntry(f.contents.get(agent.configPath)!, target.format),
    ).toBeUndefined();
    expect(f.backups).toHaveLength(2);
    expect((await f.hub.inventory()).integrations).toEqual([]);
  },
);
it('persists all 17 integration records in one workspace without a legacy nine-agent bound', async () => {
  const f = fixture();
  const scan = await f.hub.integrations.scan();
  for (const agent of scan.agents)
    await f.hub.integrations.integrate(agent.agentId, {
      expectedRevision: (await f.hub.inventory()).revision,
      fingerprint: agent.fingerprint,
      confirmConfigurationChange: true,
    });
  expect((await f.hub.inventory()).integrations).toHaveLength(17);
  expect(
    (await f.hub.integrations.sync()).agents.every(
      (agent) => agent.status === 'synced',
    ),
  ).toBe(true);
});
it('retains requested Windows paths alongside documented current scopes and deduplicates case-equivalent candidates', () => {
  const targets = windowsAgentTargets('C:\\User', {
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
    }),
    paths = (id: string) => targets.find((target) => target.id === id)!.paths;
  expect(paths('windsurf')).toContain(
    'C:\\User\\.codeium\\windsurf\\mcp_config.json',
  );
  expect(paths('cline')).toContain(
    'C:\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json',
  );
  expect(paths('roo-code')).toContain(
    'C:\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\cline_mcp_settings.json',
  );
  expect(paths('zed')).toEqual([
    'C:\\Roaming\\Zed\\settings.json',
    'C:\\User\\.config\\zed\\settings.json',
  ]);
  expect(paths('gemini-cli')).toEqual([
    'C:\\User\\.gemini\\settings.json',
    'C:\\User\\.gemini\\mcp.json',
  ]);
  expect(paths('goose')).toContain('C:\\Local\\Block\\Goose\\config.yaml');
  expect(paths('jetbrains')).toContain('C:\\Roaming\\JetBrains\\mcp.json');
  expect(paths('warp')).toContain('C:\\Local\\warp\\mcp.json');
  expect(paths('warp')).toContain('C:\\User\\.warp\\mcp.json');
  expect(
    windowsAgentTargets('C:\\User', {
      APPDATA: 'C:\\Config',
      XDG_CONFIG_HOME: 'C:\\Config',
    }).find((target) => target.id === 'zed')!.paths,
  ).toHaveLength(1);
});
it('does not invent missing extension/JetBrains scopes or change overridden runtime scopes', async () => {
  const f = fixture();
  for (const id of ['cline', 'roo-code', 'jetbrains']) {
    const target = f.targets.find((target) => target.id === id)!;
    f.contents.delete(target.paths[0]!);
  }
  const scan = await f.hub.integrations.scan();
  for (const id of ['cline', 'roo-code', 'jetbrains'] as const) {
    const agent = scan.agents.find((agent) => agent.agentId === id)!;
    expect(agent.status).toBe('unknown');
    await expect(
      f.hub.integrations.integrate(id, {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toHaveProperty('code', 'conflict');
  }
  expect(f.effects().writes).toBe(0);
  const blocked = windowsAgentTargets('C:\\User', {
    GEMINI_CLI_HOME: 'C:\\CustomGemini',
    GOOSE_CONFIG_DIR: 'C:\\CustomGoose',
  });
  expect(blocked.find((target) => target.id === 'gemini-cli')!.blocked).toBe(
    true,
  );
  expect(blocked.find((target) => target.id === 'goose')!.blocked).toBe(true);
});
it.each(['zed', 'gemini-cli', 'goose', 'warp'] as const)(
  '%s refuses ambiguous candidates and same-bytes scope relocation from a stale scan',
  async (id) => {
    const f = fixture(),
      target = f.targets.find((target) => target.id === id)!,
      scan = (await f.hub.integrations.scan()).agents.find(
        (agent) => agent.agentId === id,
      )!,
      text = f.contents.get(target.paths[0]!)!;
    f.contents.set(target.paths[1]!, text);
    expect((await f.hub.integrations.status(id)).reason).toBe(
      'ambiguous_scope',
    );
    f.contents.delete(target.paths[0]!);
    // Another window may scan the moved scope; identical bytes are not the same handle.
    await f.hub.integrations.scan();
    await expect(
      f.hub.integrations.integrate(id, {
        expectedRevision: 0,
        fingerprint: scan.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toHaveProperty('code', 'conflict');
    expect(f.effects().writes).toBe(0);
  },
);
it.each(newAgentIds)(
  '%s rejects stale registry/content/managed ownership without any overwrite',
  async (id) => {
    const f = fixture(),
      agent = (await f.hub.integrations.scan()).agents.find(
        (agent) => agent.agentId === id,
      )!,
      target = f.targets.find((target) => target.id === id)!;
    await expect(
      f.hub.integrations.integrate(id, {
        expectedRevision: 99,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toHaveProperty('code', 'conflict');
    f.contents.set(
      agent.configPath,
      f.contents.get(agent.configPath)! +
        (target.format === 'goose' ? '# changed\n' : '// changed\n'),
    );
    await expect(
      f.hub.integrations.integrate(id, {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toHaveProperty('code', 'conflict');
    expect(f.effects().writes).toBe(0);
    const current = await f.hub.integrations.status(id);
    await f.hub.integrations.integrate(id, {
      expectedRevision: 0,
      fingerprint: current.fingerprint,
      confirmConfigurationChange: true,
    });
    f.contents.set(
      agent.configPath,
      f.contents
        .get(agent.configPath)!
        .replace('SyntheticNode24', 'ForeignNode'),
    );
    const drift = await f.hub.integrations.status(id);
    expect(drift.status).toBe('unknown');
    await expect(
      f.hub.integrations.disconnect(id, {
        expectedRevision: 1,
        fingerprint: drift.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toHaveProperty('code', 'conflict');
  },
);
it('supports Zed context_servers and a single mcpServers compatibility map without changing client policies', () => {
  const entry = agentEntry('zed', 'node', 'bridge', 'registry', 'zed');
  for (const key of ['context_servers', 'mcpServers']) {
    const source = `// preserve\n{"agent":{"tool_permissions":{"default":"confirm"}},"${key}":{"other":{"command":"keep"}}}`;
    const result = editAgentDocument(source, 'zed', entry);
    expect(
      (parseAgentDocument(result, 'zed')[key] as Record<string, unknown>)[
        'waleed-mcp-hub'
      ],
    ).toEqual(entry);
    expect(result).toContain('"default":"confirm"');
  }
  expect(() =>
    editAgentDocument('{"context_servers":{},"mcpServers":{}}', 'zed', entry),
  ).toThrow();
});
it.each([
  'extensions:\n  x: 1\n  x: 2\n',
  'extensions: &shared {}\nother: *shared\n',
  'extensions:\n  <<: {x: 1}\n',
  'extensions: !custom {}\n',
  'extensions: {}\n---\nother: true\n',
  'extensions: []\n',
  'extensions: {other: {cmd: keep}}\n',
  '__proto__: {}\n',
  'extensions:\n  x: .nan\n',
  '? &key extensions\n: {}\n',
  '!!str extensions: {}\n',
])('rejects unsafe/ambiguous Goose YAML %j', (source) =>
  expect(() =>
    editAgentDocument(
      source,
      'goose',
      agentEntry('goose', 'node', 'bridge', 'state', 'goose'),
    ),
  ).toThrow(),
);
it.each([
  '',
  '\uFEFF# preserve BOM\r\nGOOSE_MODE: approve\r\n',
  'extensions: {} # preserve header comment\n',
])(
  'supports empty/BOM/CRLF/empty-parent Goose YAML without rewriting comments',
  (source) => {
    const entry = agentEntry(
        'goose',
        'C:\\Node Space\\node.exe',
        'C:\\Hub\\bridge.js',
        'C:\\Hub\\state.json',
        'goose',
      ),
      added = editAgentDocument(source, 'goose', entry);
    expect(managedEntry(added, 'goose')).toEqual(entry);
    if (source.includes('BOM')) {
      expect(added.startsWith('\uFEFF# preserve BOM\r\n')).toBe(true);
      expect(added.replaceAll('\r\n', '')).not.toContain('\n');
    }
    if (source.includes('header comment'))
      expect(added).toContain('extensions:  # preserve header comment\n');
    const removed = editAgentDocument(
      added,
      'goose',
      undefined,
      hashData(entry),
    );
    expect(managedEntry(removed, 'goose')).toBeUndefined();
    if (source.includes('header comment'))
      expect(removed).toContain('# preserve header comment');
  },
);
it.each(newAgentIds)(
  '%s uses the same profile/search/policy dispatch chain and refuses stale out-of-scope handles',
  async (id) => {
    const f = playgroundFixture(),
      bridge = createAgentBridge(
        async () => structuredClone(f.state),
        f.connect,
        id,
      ),
      [a, b] = InMemoryTransport.createLinkedPair(),
      client = new Client(
        { name: 'synthetic-new-agent', version: '1' },
        { capabilities: {} },
      );
    cleanup.push(async () => {
      await client.close();
      await bridge.close();
      await f.playground.close();
    });
    await bridge.connect(a);
    await client.connect(b);
    f.state.agentProfileBindings = { [id]: 'profile' };
    f.state.agentToolSearchModes = { [id]: true };
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_tools',
      'call_tool',
    ]);
    const search = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'read' },
    });
    expect(
      (search.structuredContent as { tools: { name: string }[] }).tools[0]!
        .name,
    ).toBe('connector-0__read');
    expect(
      await client.callTool({
        name: 'call_tool',
        arguments: { name: 'connector-0__read' },
      }),
    ).not.toHaveProperty('isError', true);
    f.state.profiles[0]!.connectorIds = [];
    expect(
      await client.callTool({
        name: 'call_tool',
        arguments: { name: 'connector-0__read' },
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'tool_scope_denied' }],
    });
    expect(f.calls).toHaveLength(1);
  },
);
it.each(newAgentIds)(
  '%s keeps a protected backup and blocking recovery after uncertain external effects',
  async (id) => {
    const f = fixture(),
      agent = (await f.hub.integrations.scan()).agents.find(
        (agent) => agent.agentId === id,
      )!;
    f.files.replace = async (path, _before, after) => {
      f.contents.set(path, after);
      throw new Error('Synthetic uncertain write.');
    };
    await expect(
      f.hub.integrations.integrate(id, {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toHaveProperty('code', 'unavailable');
    expect(f.backups).toHaveLength(1);
    expect((await f.safety.read()).operations[0]!.phase).toBe('needs_review');
    await expect(f.safety.assertWritable()).rejects.toHaveProperty(
      'code',
      'conflict',
    );
  },
);
it.each(newAgentIds)(
  '%s aborts before any configuration effect if its private backup cannot be confirmed',
  async (id) => {
    const f = fixture(),
      agent = (await f.hub.integrations.scan()).agents.find(
        (agent) => agent.agentId === id,
      )!,
      original = f.contents.get(agent.configPath);
    f.files.backup = async () => {
      throw new Error('Synthetic backup protection failure.');
    };
    await expect(
      f.hub.integrations.integrate(id, {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toHaveProperty('code', 'unavailable');
    expect(f.contents.get(agent.configPath)).toBe(original);
    expect(f.effects().writes).toBe(0);
    expect((await f.safety.read()).operations[0]!.phase).toBe('aborted');
    expect((await f.hub.inventory()).revision).toBe(0);
  },
);
it('creates restricted .bak files and calls the private-path guard before publishing new agent configs', async () => {
  const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\more-agent-files-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'settings.json'),
    backups = join(directory, 'backups'),
    protectedPaths: string[] = [];
  await mkdir(directory, { recursive: true });
  const files = agentFiles([config], backups, async (path) => {
    protectedPaths.push(path);
  });
  for (const agent of newAgentIds) {
    const name = await files.backup(agent, 'SYNTHETIC-PRIVATE-BACKUP');
    expect(name).toMatch(new RegExp(`^${agent}-.+\\.bak$`));
    expect(await readFile(join(backups, name), 'utf8')).toBe(
      'SYNTHETIC-PRIVATE-BACKUP',
    );
  }
  await files.replace(config, null, '{"safe":true}');
  expect(protectedPaths).toContain(backups);
  expect(
    protectedPaths.some(
      (path) => path.includes('.wmh-') && path.endsWith('.tmp'),
    ),
  ).toBe(true);
  expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(
    false,
  );
});
