import { win32 } from 'node:path';
import { AgentIdSchema, type DiscoveredAgent } from '@waleed/contracts';
import { inspectAgentFile, parseDocument } from './metadata.js';
import type { DiscoveryPorts, DiscoverySettings } from './ports.js';

const specs = {
  opencode: { aliases: ['opencode', 'opencode2'], package: '@opencode/cli' },
  codex: { aliases: ['codex'], package: '@openai/codex' },
  antigravity: { aliases: ['agy'], package: null },
  grok: { aliases: ['grok'], package: null },
  claude: { aliases: ['claude'], package: '@anthropic-ai/claude-code' },
  kilo: { aliases: ['kilo', 'kilocode'], package: '@kilocode/cli' },
  kimi: { aliases: ['kimi'], package: '@moonshot-ai/kimi-code' },
  cursor: { aliases: ['cursor-agent'], package: null },
} as const;
export function pendingAgents(): DiscoveredAgent[] {
  return AgentIdSchema.options.map((agentId) => ({
    agentId,
    executable: null,
    version: null,
    detected: null,
    compatibility: 'pending',
    registered: null,
    reconnectRequired: null,
    checkedAt: null,
    aliases: [...specs[agentId].aliases],
    resolution: 'not_checked',
    versionSource: 'unknown',
    configFiles: [],
    configSummary: 'pending',
    scope: 'user_files_only',
    verification: 'not_performed',
  }));
}

export async function discoverAgents(
  ports: DiscoveryPorts,
  settings: DiscoverySettings,
  signal: AbortSignal,
  checkedAt: string,
): Promise<DiscoveredAgent[]> {
  const agents = pendingAgents();
  for (const agent of agents) {
    if (signal.aborted) break;
    try {
      const spec = specs[agent.agentId];
      const found = await ports.find(spec.aliases, signal);
      agent.executable = found[0] ?? null;
      agent.detected = found.length > 0;
      agent.resolution = found[0]
        ? win32.extname(found[0]).toLowerCase() === '.exe'
          ? 'exe'
          : 'shim'
        : 'missing';
      agent.checkedAt = checkedAt;
      // Read installed manifest metadata, never execute a package bin, install
      // hook, shim, agent startup, MCP list, or model turn merely for a version.
      if (found[0] && spec.package) {
        const manifest = await ports.read(
          win32.join(
            win32.dirname(found[0]),
            'node_modules',
            spec.package,
            'package.json',
          ),
          signal,
        );
        if (manifest.status === 'read') {
          try {
            const document = parseDocument(manifest.text, 'json');
            if (
              document.name === spec.package &&
              typeof document.version === 'string' &&
              /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(document.version) &&
              document.version.length <= 60
            ) {
              agent.version = document.version;
              agent.versionSource = 'manifest';
            }
          } catch {
            /* Unknown version is not executable/adapter compatibility. */
          }
        }
      }
      const home = settings.home;
      const env = settings.environment;
      const files: Array<{
        path: string;
        format: 'jsonc' | 'toml';
        shape: 'opencode' | 'codex' | 'mcpServers' | 'policy';
      }> = [];
      if (agent.agentId === 'opencode') {
        const base = win32.join(
          env.XDG_CONFIG_HOME || win32.join(home, '.config'),
          'opencode',
        );
        files.push(
          ...['opencode.json', 'opencode.jsonc'].map((name) => ({
            path: win32.join(base, name),
            format: 'jsonc' as const,
            shape: 'opencode' as const,
          })),
        );
        if (env.OPENCODE_CONFIG)
          files.push({
            path: env.OPENCODE_CONFIG,
            format: 'jsonc',
            shape: 'opencode',
          });
      } else if (agent.agentId === 'codex')
        files.push({
          path: win32.join(
            env.CODEX_HOME || win32.join(home, '.codex'),
            'config.toml',
          ),
          format: 'toml',
          shape: 'codex',
        });
      else if (agent.agentId === 'claude' && !env.CLAUDE_CONFIG_DIR)
        files.push(
          {
            path: win32.join(home, '.claude.json'),
            format: 'jsonc',
            shape: 'mcpServers',
          },
          {
            path: win32.join(home, '.claude', 'settings.json'),
            format: 'jsonc',
            shape: 'policy',
          },
        );
      else if (agent.agentId === 'cursor')
        files.push({
          path: win32.join(home, '.cursor', 'mcp.json'),
          format: 'jsonc',
          shape: 'mcpServers',
        });
      else if (agent.agentId === 'antigravity')
        files.push({
          path: win32.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
          format: 'jsonc',
          shape: 'mcpServers',
        });
      // Grok/Kilo/Kimi config scope is deliberately pending, not a guessed legacy
      // schema. P7 must verify their current version-specific native interface.
      for (const file of files) {
        const read = await ports.read(file.path, signal);
        agent.configFiles.push(
          inspectAgentFile(
            file.path,
            read,
            file.format,
            file.shape,
            settings.profileId,
            win32.join(settings.pilotDirectory, 'Start-Chrome.ps1'),
          ),
        );
      }
      const bindings = new Set(
        agent.configFiles.flatMap((file) => file.hubEntries),
      );
      agent.configSummary = !files.length
        ? 'pending'
        : agent.configFiles.some((file) =>
              ['invalid', 'inaccessible', 'too_large', 'unsafe'].includes(
                file.status,
              ),
            )
          ? 'error'
          : agent.configFiles.some((file) => file.binding === 'conflict')
            ? 'conflict'
            : agent.configFiles.some((file) => file.status === 'unsupported')
              ? 'pending'
              : bindings.size === 2
                ? 'matching'
                : bindings.size
                  ? 'partial'
                  : 'absent';
      // Multiple user config layers, CLI flags, project and inherited/account
      // connections are NOT an effective-config verification.
      if (
        agent.agentId === 'opencode' &&
        agent.configFiles.filter(
          (file) => file.status === 'read' && file.entryCount,
        ).length > 1 &&
        agent.configSummary === 'matching'
      )
        agent.configSummary = 'partial';
    } catch {
      agent.resolution = 'error';
      agent.detected = null;
      agent.configSummary = 'error';
      agent.checkedAt = checkedAt;
    }
  }
  return agents;
}
