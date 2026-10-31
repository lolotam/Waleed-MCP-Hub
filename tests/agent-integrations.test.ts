import { describe, it, expect } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsAgentTargets,
} from '@waleed/hub-core';
import {
  hashData,
  hashBytes,
} from '../packages/hub-core/src/runtime/registry.js';
import {
  editAgentDocument,
  managedEntry,
  agentEntry,
  type AgentFormat,
} from '../packages/hub-core/src/integrations/formats.js';
import type { AgentFiles } from '../packages/hub-core/src/integrations/files.js';
import { memoryStore } from './helpers/memory-store.js';
import { emptyState } from '@waleed/hub-core';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDesktopConfig } from '../packages/hub-core/src/integrations/targets.js';

it('targets the config folder the installed Claude Desktop build actually reads', () => {
  const home = mkdtempSync(join(tmpdir(), 'wmh-claude-'));
  const env = {
    APPDATA: join(home, 'Roaming'),
    LOCALAPPDATA: join(home, 'Local'),
  };
  try {
    // Classic installer.
    expect(claudeDesktopConfig(home, env)).toBe(
      join(env.APPDATA, 'Claude', 'claude_desktop_config.json'),
    );
    // Older Store build: data lives in the package's virtualized roaming folder.
    const roaming = join(
      env.LOCALAPPDATA,
      'Packages',
      'Claude_abc123',
      'LocalCache',
      'Roaming',
      'Claude',
    );
    mkdirSync(roaming, { recursive: true });
    expect(claudeDesktopConfig(home, env)).toBe(
      join(env.APPDATA, 'Claude', 'claude_desktop_config.json'),
    );
    mkdirSync(join(roaming, 'logs'));
    expect(claudeDesktopConfig(home, env)).toBe(
      join(roaming, 'claude_desktop_config.json'),
    );
    // Current Store build: relocated user data wins.
    const relocated = join(env.LOCALAPPDATA, 'Claude-Data', 'claude_abc123');
    mkdirSync(relocated, { recursive: true });
    expect(claudeDesktopConfig(home, env)).toBe(
      join(relocated, 'claude_desktop_config.json'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const targets = windowsAgentTargets('C:\\Synthetic', {
  APPDATA: 'C:\\Synthetic\\Roaming',
});
const source = (format: AgentFormat) =>
  format === 'codex'
    ? '# preserve this comment\nmodel = "synthetic"\n[tools]\nnode_repl = true\n[mcp_servers.other]\ncommand = "unchanged"\n'
    : '{\n // Preserve plugins and policy\n "plugins": ["keep"], "denylist": ["rube", "byterover"], "unrelated": {"credential": "SYNTHETIC_PRIVATE_EXISTING"}\n}\n';
function setup() {
  const contents = new Map(
    targets.map((target) => [target.paths[0]!, source(target.format)]),
  );
  const backups: string[] = [];
  const files: AgentFiles = {
    async read(path) {
      return contents.get(path) ?? null;
    },
    async replace(path, before, after) {
      if ((contents.get(path) ?? null) !== before) throw new Error();
      contents.set(path, after);
    },
    async backup(_id, text) {
      backups.push(text);
      return 'synthetic-timestamp.bak';
    },
  };
  const store = memoryStore(emptyState()),
    safety = createMemorySafetyLedger();
  const hub = createLifecycle(store, Date.now, safety, {
    integrations: {
      targets,
      files,
      registry: 'C:\\Runtime\\state.json',
      node: 'C:\\Node24\\node.exe',
      bridge: 'C:\\Hub\\bridge.js',
      discovery: {
        async find() {
          return ['C:\\Node24\\agent.exe'];
        },
        async read(path) {
          const target = targets.find(
            (item) => item.packageName && path.includes(item.packageName),
          );
          return target
            ? {
                status: 'read',
                text: JSON.stringify({
                  name: target.packageName,
                  version: '2.0.0',
                }),
                fingerprint: '0'.repeat(64),
              }
            : { status: 'missing' };
        },
        async run() {
          throw new Error('Scanning must not execute agents.');
        },
      },
    },
  });
  return { hub, contents, backups, files, safety };
}
describe('comment-preserving managed agent entries', () => {
  it.each(targets)(
    '$name integrates/disconnects without changing unrelated configuration',
    async (target) => {
      const { hub, contents, backups } = setup();
      const original = contents.get(target.paths[0]!)!;
      const result = await hub.integrations.scan();
      const agent = result.agents.find((item) => item.agentId === target.id)!;
      expect(agent.status).toBe('not_integrated');
      expect(JSON.stringify(result)).not.toContain(
        'SYNTHETIC_PRIVATE_EXISTING',
      );
      const receipt = await hub.integrations.integrate(target.id, {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      });
      expect(receipt.agent.status).toBe('integrated');
      expect(backups[0]).toBe(original);
      const integrated = contents.get(target.paths[0]!)!;
      expect(integrated.toLowerCase()).toContain('preserve');
      if (target.id === 'codex')
        expect(integrated).toContain('node_repl = true');
      expect(JSON.stringify(receipt)).not.toContain(
        'SYNTHETIC_PRIVATE_EXISTING',
      );
      expect((await hub.integrations.sync()).agents[0]?.status).toBe('synced');
      // Preserve a newer unrelated comment added after integration.
      contents.set(
        target.paths[0]!,
        integrated +
          (target.format === 'codex'
            ? '# later unrelated comment\n'
            : '// later unrelated comment\n'),
      );
      const fresh = await hub.integrations.status(target.id);
      const removed = await hub.integrations.disconnect(target.id, {
        expectedRevision: 1,
        fingerprint: fresh.fingerprint,
        confirmConfigurationChange: true,
      });
      expect(removed.agent.status).toBe('not_integrated');
      expect(contents.get(target.paths[0]!)).toContain(
        'later unrelated comment',
      );
      expect(
        managedEntry(contents.get(target.paths[0]!)!, target.format),
      ).toBeUndefined();
      expect((await hub.inventory()).integrations).toEqual([]);
      await hub.close();
    },
  );
  it('keeps every supported agent integrated at the same time', async () => {
    const { hub } = setup();
    const scanned = await hub.integrations.scan();
    expect(scanned.agents.map((agent) => agent.agentId).sort()).toEqual(
      targets.map((target) => target.id).sort(),
    );
    for (const agent of scanned.agents) {
      const receipt = await hub.integrations.integrate(agent.agentId, {
        expectedRevision: (await hub.inventory()).revision,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      });
      expect(receipt.agent.status).toBe('integrated');
    }
    expect((await hub.inventory()).integrations).toHaveLength(targets.length);
    await hub.close();
  });
  it('rejects duplicate keys, invalid parent shapes, foreign entries and forged ownership', () => {
    for (const text of [
      '{"mcpServers":{},"mcpServers":{}}',
      '{"mcpServers":[]}',
      '{"mcpServers":{"waleed-mcp-hub":{"command":"foreign"}}}',
    ])
      expect(() =>
        editAgentDocument(text, 'mcpServers', { command: 'managed' }),
      ).toThrow();
    expect(() =>
      editAgentDocument(
        '[mcp_servers.waleed-mcp-hub]\ncommand="foreign"\n',
        'codex',
        { command: 'managed' },
      ),
    ).toThrow();
  });
  it('rejects stale scans/revisions, then blocks changed managed entries rather than deleting them', async () => {
    const { hub, contents } = setup();
    const scanned = await hub.integrations.scan();
    const agent = scanned.agents[0]!;
    await expect(
      hub.integrations.integrate(agent.agentId, {
        expectedRevision: 9,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    contents.set(
      agent.configPath,
      contents.get(agent.configPath)! + '// external edit\n',
    );
    await expect(
      hub.integrations.integrate(agent.agentId, {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await hub.integrations.status(agent.agentId);
    await hub.integrations.integrate(agent.agentId, {
      expectedRevision: 0,
      fingerprint: fresh.fingerprint,
      confirmConfigurationChange: true,
    });
    contents.set(
      agent.configPath,
      contents.get(agent.configPath)!.replace('node.exe', 'changed.exe'),
    );
    const drift = await hub.integrations.status(agent.agentId);
    expect(drift.status).toBe('unknown');
    await expect(
      hub.integrations.disconnect(agent.agentId, {
        expectedRevision: 1,
        fingerprint: drift.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toBeDefined();
    await hub.close();
  });
  it('journals before effects and retains blocking recovery if an external write becomes uncertain', async () => {
    const { hub, files, safety, contents } = setup();
    const agent = (await hub.integrations.scan()).agents[0]!;
    files.replace = async (path, _before, after) => {
      expect((await safety.read()).operations[0]?.phase).toBe('prepared');
      contents.set(path, after);
      throw new Error('SYNTHETIC post-write error');
    };
    await expect(
      hub.integrations.integrate(agent.agentId, {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    ).rejects.toBeDefined();
    expect((await safety.read()).operations[0]?.phase).toBe('needs_review');
    expect((await hub.inventory()).revision).toBe(0);
    await hub.close();
  });
  it('emits exactly the documented OpenCode V2/Kimi/Kilo/VS Code scopes', () => {
    expect(
      agentEntry('opencode', 'node', 'bridge', 'state', 'opencode'),
    ).toEqual({
      type: 'local',
      command: ['node', 'bridge', 'state', 'opencode'],
    });
    expect(targets.find((item) => item.id === 'kimi')?.paths[0]).toContain(
      '.kimi-code\\mcp.json',
    );
    expect(targets.find((item) => item.id === 'vscode')?.paths[0]).toContain(
      'Code\\User\\mcp.json',
    );
    expect(targets.find((item) => item.id === 'kilo')?.format).toBe('kilo');
    expect(targets.find((item) => item.id === 'grok')).toMatchObject({
      paths: ['C:\\Synthetic\\.grok\\config.toml'],
      format: 'codex',
      aliases: ['grok'],
    });
    expect(
      windowsAgentTargets('C:\\Synthetic', {
        GROK_HOME: 'D:\\GrokHome',
      }).find((item) => item.id === 'grok')?.paths,
    ).toEqual(['D:\\GrokHome\\config.toml']);
    const entry = agentEntry('opencode', 'node', 'bridge', 'state', 'opencode');
    const document = editAgentDocument('{}', 'opencode', entry);
    expect(hashData(managedEntry(document, 'opencode'))).toBe(hashData(entry));
    expect(hashBytes(document)).toHaveLength(64);
  });
  it('adds the Grok entry to a Grok config.toml and keeps every other setting', () => {
    // The shape of a real Grok config.toml: tables, an array of tables, keys.
    const grok = [
      '[cli]',
      'installer = "internal"',
      '',
      '[[marketplace.sources]]',
      'name = "xAI Official"',
      'git = "https://github.com/xai-org/plugin-marketplace.git"',
      '',
      '[ui]',
      'yolo = false',
      'permission_mode = "always-approve"',
      '',
    ].join('\n');
    const entry = agentEntry(
      'codex',
      'C:\\Node24\\node.exe',
      'C:\\Hub\\bridge.js',
      'C:\\Runtime\\state.json',
      'grok',
    );
    const document = editAgentDocument(grok, 'codex', entry);
    // Only the marked block is appended; the settings above stay as written.
    expect(document.startsWith(grok)).toBe(true);
    expect(managedEntry(document, 'codex')).toEqual({
      command: 'C:\\Node24\\node.exe',
      args: ['C:\\Hub\\bridge.js', 'C:\\Runtime\\state.json', 'grok'],
      startup_timeout_sec: 30,
    });
    const removed = editAgentDocument(
      document,
      'codex',
      undefined,
      hashData(managedEntry(document, 'codex')),
    );
    expect(removed).toBe(grok);
  });
});
