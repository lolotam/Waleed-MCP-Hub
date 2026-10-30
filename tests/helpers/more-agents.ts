import {
  windowsAgentTargets,
  createLifecycle,
  createMemorySafetyLedger,
} from '@waleed/hub-core';
import type { AgentTarget } from '../../packages/hub-core/src/integrations/targets.js';
import type { AgentFiles } from '../../packages/hub-core/src/integrations/files.js';
import { memoryStore } from './memory-store.js';
import { profileState } from './runtime.js';

export const newAgentIds = [
  'windsurf',
  'cline',
  'roo-code',
  'zed',
  'gemini-cli',
  'goose',
  'jetbrains',
  'warp',
] as const;
export function agentSource(target: AgentTarget) {
  if (target.format === 'goose')
    return '# Keep provider, permissions and external extensions\nGOOSE_PROVIDER: synthetic\nGOOSE_MODE: approve\nextensions:\n  developer:\n    type: builtin\n    name: developer\n    enabled: true\n  other:\n    type: stdio\n    cmd: synthetic.exe\n    args: [literal]\n    envs: {PRIVATE_VALUE: SYNTHETIC-EXISTING-PRIVATE}\n# keep footer\n';
  if (target.format === 'codex')
    return '# Keep provider permissions\nmodel = "synthetic"\n[mcp_servers.other]\ncommand = "synthetic.exe"\n';
  const map =
    target.format === 'zed'
      ? 'context_servers'
      : target.format === 'opencode'
        ? 'mcp'
        : target.format === 'kilo'
          ? 'mcp'
          : target.format === 'vscode'
            ? 'servers'
            : 'mcpServers';
  const servers =
    target.format === 'opencode'
      ? { servers: { other: { command: ['synthetic.exe'], type: 'local' } } }
      : {
          other: {
            command: 'synthetic.exe',
            args: ['literal'],
            autoApprove: [],
            env: { PRIVATE_VALUE: 'SYNTHETIC-EXISTING-PRIVATE' },
          },
        };
  return (
    '// Keep provider and permissions\n' +
    JSON.stringify(
      { theme: 'keep', permissions: { approval: 'ask' }, [map]: servers },
      null,
      2,
    ) +
    '\n'
  );
}
export function moreAgentsFixture() {
  const targets = windowsAgentTargets('C:\\SyntheticMoreAgents', {
      APPDATA: 'C:\\SyntheticMoreAgents\\Roaming',
      LOCALAPPDATA: 'C:\\SyntheticMoreAgents\\Local',
    }),
    contents = new Map(
      targets.map((target) => [target.paths[0]!, agentSource(target)]),
    ),
    backups: Array<{ agent: string; text: string }> = [];
  let writes = 0,
    probes = 0;
  const files: AgentFiles = {
    async read(path) {
      return contents.get(path) ?? null;
    },
    async replace(path, before, after) {
      if ((contents.get(path) ?? null) !== before)
        throw new Error('Synthetic config drift.');
      contents.set(path, after);
      writes++;
    },
    async backup(agent, text) {
      backups.push({ agent, text });
      return `${agent}-synthetic.bak`;
    },
  };
  const store = memoryStore(profileState(['native'])),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety, {
      integrations: {
        targets,
        files,
        node: 'C:\\SyntheticNode24\\node.exe',
        registry: 'C:\\SyntheticMoreAgents\\state.json',
        bridge: 'C:\\SyntheticHub\\bridge.js',
        discovery: {
          async find(names) {
            probes++;
            return names.length ? [`C:\\SyntheticAgents\\${names[0]}.exe`] : [];
          },
          async read(path) {
            const target = targets.find(
              (target) =>
                target.packageName && path.includes(target.packageName),
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
            throw new Error('No agent or connector may be started by a scan.');
          },
        },
      },
    });
  return {
    targets,
    contents,
    backups,
    files,
    store,
    safety,
    hub,
    effects: () => ({ writes, backups: backups.length, probes }),
    close: () => hub.close(),
  };
}
