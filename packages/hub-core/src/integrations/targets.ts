import { readdirSync } from 'node:fs';
import { win32 } from 'node:path';
import type { IntegrationAgentId } from '@waleed/contracts';
import type { AgentFormat } from './formats.js';

export interface AgentTarget {
  id: IntegrationAgentId;
  name: string;
  paths: string[];
  format: AgentFormat;
  aliases: string[];
  packageName?: string;
  reconnect: string;
  blocked?: boolean;
}
const directories = (path: string) => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};
// The Microsoft Store (MSIX) build of Claude Desktop never reads
// %APPDATA%\Claude. Current builds keep user data in
// %LOCALAPPDATA%\Claude-Data\claude_<publisher>; older builds used the package's
// virtualized roaming folder. Pick the one folder Claude actually uses.
export function claudeDesktopConfig(
  home: string,
  env: Record<string, string | undefined>,
) {
  const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
  const appdata = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
  const file = 'claude_desktop_config.json';
  const relocated = win32.join(local, 'Claude-Data');
  const [data] = directories(relocated).filter((name) =>
    /^claude_[a-z0-9]+$/i.test(name),
  );
  if (data) return win32.join(relocated, data, file);
  const packages = win32.join(local, 'Packages');
  for (const name of directories(packages).filter((name) =>
    /^Claude_[a-z0-9]+$/i.test(name),
  )) {
    const roaming = win32.join(
      packages,
      name,
      'LocalCache',
      'Roaming',
      'Claude',
    );
    // A marker-only folder means the data moved out; real data has subfolders.
    if (directories(roaming).length) return win32.join(roaming, file);
  }
  return win32.join(appdata, 'Claude', file);
}
export function windowsAgentTargets(
  home: string,
  env: Record<string, string | undefined>,
): AgentTarget[] {
  const config = env.XDG_CONFIG_HOME || win32.join(home, '.config');
  const appdata = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
  const restart =
    'Configuration saved only. Reconnect/restart this agent and review its MCP approval prompts.';
  return [
    {
      id: 'opencode',
      name: 'OpenCode CLI',
      paths: env.OPENCODE_CONFIG
        ? [env.OPENCODE_CONFIG]
        : ['opencode.json', 'opencode.jsonc'].map((file) =>
            win32.join(config, 'opencode', file),
          ),
      format: 'opencode',
      aliases: ['opencode', 'opencode2'],
      packageName: '@opencode/cli',
      reconnect:
        'OpenCode watches configuration. Use /reload if needed; verify /mcps. Project overrides can still win.',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      paths: [
        win32.join(env.CODEX_HOME || win32.join(home, '.codex'), 'config.toml'),
      ],
      format: 'codex',
      aliases: ['codex'],
      packageName: '@openai/codex',
      reconnect: restart,
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      paths: [claudeDesktopConfig(home, env)],
      format: 'mcpServers',
      aliases: ['Claude'],
      reconnect:
        'Quit Claude Desktop completely and reopen it; review connector approval.',
    },
    {
      id: 'claude',
      name: 'Claude Code CLI',
      paths: [win32.join(home, '.claude.json')],
      format: 'mcpServers',
      aliases: ['claude'],
      packageName: '@anthropic-ai/claude-code',
      reconnect: restart,
      blocked: !!env.CLAUDE_CONFIG_DIR,
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      paths: [win32.join(home, '.gemini', 'antigravity', 'mcp_config.json')],
      format: 'mcpServers',
      aliases: ['agy'],
      reconnect: restart,
    },
    {
      id: 'vscode',
      name: 'VS Code',
      paths: [win32.join(appdata, 'Code', 'User', 'mcp.json')],
      format: 'vscode',
      aliases: ['code'],
      reconnect:
        'Run MCP: List Servers, start/reconnect the hub and review trust. Other profiles/remote scopes are not modified.',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      paths: [win32.join(home, '.cursor', 'mcp.json')],
      format: 'mcpServers',
      aliases: ['cursor', 'cursor-agent'],
      reconnect: restart,
    },
    {
      id: 'kimi',
      name: 'Kimi Code CLI',
      paths: [
        win32.join(
          env.KIMI_CODE_HOME || win32.join(home, '.kimi-code'),
          'mcp.json',
        ),
      ],
      format: 'mcpServers',
      aliases: ['kimi'],
      packageName: '@moonshot-ai/kimi-code',
      reconnect:
        'Current Kimi Code scope only; legacy ~/.kimi is not edited. Open a new session and check /mcp.',
    },
    {
      id: 'kilo',
      name: 'Kilo Code CLI',
      paths: ['kilo.json', 'kilo.jsonc', 'config.json'].map((file) =>
        win32.join(config, 'kilo', file),
      ),
      format: 'kilo',
      aliases: ['kilo', 'kilocode'],
      packageName: '@kilocode/cli',
      reconnect: restart,
    },
    {
      // Grok reads MCP servers from its own config.toml, in the same TOML
      // shape as Codex. It also reads Claude Code's and Cursor's files; its
      // own entry wins over theirs for the same server name.
      id: 'grok',
      name: 'Grok CLI',
      paths: [
        win32.join(env.GROK_HOME || win32.join(home, '.grok'), 'config.toml'),
      ],
      format: 'codex',
      aliases: ['grok'],
      reconnect:
        'Start a new Grok session and check /mcps or `grok mcp list`. This entry takes precedence over the hub entries Grok also reads from Claude Code and Cursor.',
    },
  ];
}
