import { readdirSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  platformDirectories,
  platformPath,
  platformPathKey,
  type HubPlatform,
} from '../platform/paths.js';
import {
  IntegrationAgentIdSchema,
  type IntegrationAgentId,
} from '@waleed/contracts';
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
  requireExisting?: boolean;
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
  return platformAgentTargets('win32', home, env);
}
export function platformAgentTargets(
  platform: HubPlatform,
  home: string,
  env: Record<string, string | undefined>,
): AgentTarget[] {
  const p = platformPath(platform);
  const roots = platformDirectories({ platform, home, environment: env });
  const config =
    env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : p.join(home, '.config');
  const appdata =
    platform === 'win32' ? roots.config : roots.applicationSupport;
  const local = roots.local;
  const restart =
    'Configuration saved only. Reconnect/restart this agent and review its MCP approval prompts.';
  const targets: AgentTarget[] = [
    {
      id: 'opencode',
      name: 'OpenCode CLI',
      paths: env.OPENCODE_CONFIG
        ? [env.OPENCODE_CONFIG]
        : ['opencode.json', 'opencode.jsonc'].map((file) =>
            p.join(config, 'opencode', file),
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
      paths: [p.join(env.CODEX_HOME || p.join(home, '.codex'), 'config.toml')],
      format: 'codex',
      aliases: ['codex'],
      packageName: '@openai/codex',
      reconnect: restart,
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      format: 'mcpServers',
      paths: [p.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
      aliases: ['windsurf'],
      reconnect:
        'Restart Windsurf/Cascade and review the Hub in MCP settings. This legacy Windsurf scope does not configure Devin Local or bypass team allowlists.',
    },
    {
      id: 'cline',
      name: 'Cline',
      format: 'mcpServers',
      paths: [
        p.join(
          appdata,
          'Code',
          'User',
          'globalStorage',
          'saoudrizwan.claude-dev',
          'settings',
          'cline_mcp_settings.json',
        ),
      ],
      aliases: [],
      requireExisting: true,
      reconnect:
        'Reload the VS Code window, open Cline MCP Servers and reconnect. This is the default VS Code extension scope, not Cline CLI, remote or alternate profiles.',
    },
    {
      id: 'roo-code',
      name: 'Roo Code',
      format: 'mcpServers',
      paths: [
        p.join(
          appdata,
          'Code',
          'User',
          'globalStorage',
          'rooveterinaryinc.roo-cline',
          'settings',
          'cline_mcp_settings.json',
        ),
      ],
      aliases: [],
      requireExisting: true,
      reconnect:
        'Reload the VS Code window, open Roo Code MCP settings and reconnect. Other VS Code profiles, remote workspaces and extension approval lists are unchanged.',
    },
    {
      id: 'zed',
      name: 'Zed',
      format: 'zed',
      paths:
        platform === 'win32'
          ? [
              p.join(appdata, 'Zed', 'settings.json'),
              p.join(config, 'zed', 'settings.json'),
            ]
          : [p.join(config, 'zed', 'settings.json')],
      aliases: ['zed'],
      reconnect:
        'Open Zed Settings → AI → MCP Servers and check the Hub. Review client tool approvals; project settings and external-agent native scopes are unchanged.',
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      format: 'mcpServers',
      paths: [
        p.join(home, '.gemini', 'settings.json'),
        p.join(home, '.gemini', 'mcp.json'),
      ],
      aliases: ['gemini'],
      packageName: '@google/gemini-cli',
      blocked: !!env.GEMINI_CLI_HOME,
      reconnect:
        'Restart Gemini CLI and check /mcp. settings.json is the documented user scope; an existing mcp.json is a compatibility scope that must be verified in your client. Project/enterprise exclusions remain unchanged.',
    },
    {
      id: 'goose',
      name: 'Goose',
      format: 'goose',
      paths:
        platform === 'win32'
          ? [
              p.join(appdata, 'Block', 'goose', 'config', 'config.yaml'),
              p.join(local, 'Block', 'Goose', 'config.yaml'),
              p.join(config, 'goose', 'config.yaml'),
            ]
          : [p.join(config, 'goose', 'config.yaml')],
      aliases: ['goose'],
      blocked: !!env.GOOSE_CONFIG_DIR,
      reconnect:
        'Restart Goose or start a new session and inspect Extensions. Only the selected config.yaml extension is changed; provider settings, tool permissions and secrets.yaml are untouched.',
    },
    {
      id: 'jetbrains',
      name: 'JetBrains AI',
      format: 'mcpServers',
      paths: [p.join(appdata, 'JetBrains', 'mcp.json')],
      aliases: [
        'idea64',
        'idea',
        'pycharm64',
        'pycharm',
        'webstorm64',
        'webstorm',
        'rider64',
        'rider',
      ],
      requireExisting: true,
      reconnect:
        'Verify this existing shared JSON scope in your IDE. JetBrains documents Settings → Tools → AI Assistant → MCP → Add/Import JSON; a file edit alone does not prove the IDE reads it. Versioned IDE/project settings are not modified.',
    },
    {
      id: 'warp',
      name: 'Warp',
      format: 'mcpServers',
      paths: [
        p.join(home, '.warp', '.mcp.json'),
        ...(platform === 'win32' ? [p.join(local, 'warp', 'mcp.json')] : []),
        p.join(home, '.warp', 'mcp.json'),
      ],
      aliases: ['warp', 'warp-terminal'],
      reconnect:
        'Review Warp Settings → Agents → MCP servers and reconnect. ~/.warp/.mcp.json is the documented file scope; other existing candidates require client verification. Auto-spawn and third-party-provider toggles are never changed.',
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      paths: [
        platform === 'win32'
          ? claudeDesktopConfig(home, env)
          : p.join(appdata, 'Claude', 'claude_desktop_config.json'),
      ],
      ...(platform === 'linux' ? { requireExisting: true } : {}),
      format: 'mcpServers',
      aliases: ['Claude'],
      reconnect:
        platform === 'linux'
          ? 'No official Linux Claude Desktop configuration is assumed. Review this existing compatibility scope with your client; no missing file is created.'
          : 'Quit Claude Desktop completely and reopen it; review connector approval.',
    },
    {
      id: 'claude',
      name: 'Claude Code CLI',
      paths: [p.join(home, '.claude.json')],
      format: 'mcpServers',
      aliases: ['claude'],
      packageName: '@anthropic-ai/claude-code',
      reconnect: restart,
      blocked: !!env.CLAUDE_CONFIG_DIR,
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      paths: [p.join(home, '.gemini', 'antigravity', 'mcp_config.json')],
      format: 'mcpServers',
      aliases: ['agy'],
      reconnect: restart,
    },
    {
      id: 'vscode',
      name: 'VS Code',
      paths: [p.join(appdata, 'Code', 'User', 'mcp.json')],
      format: 'vscode',
      aliases: ['code'],
      reconnect:
        'Run MCP: List Servers, start/reconnect the hub and review trust. Other profiles/remote scopes are not modified.',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      paths: [p.join(home, '.cursor', 'mcp.json')],
      format: 'mcpServers',
      aliases: ['cursor', 'cursor-agent'],
      reconnect: restart,
    },
    {
      id: 'kimi',
      name: 'Kimi Code CLI',
      paths: [
        p.join(env.KIMI_CODE_HOME || p.join(home, '.kimi-code'), 'mcp.json'),
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
        p.join(config, 'kilo', file),
      ),
      format: 'kilo',
      aliases: ['kilo', 'kilocode'],
      packageName: '@kilocode/cli',
      reconnect: restart,
    },
  ];
  return targets
    .map((target) => ({
      ...target,
      paths: [
        ...new Map(
          target.paths.map((path) => [platformPathKey(path, platform), path]),
        ).values(),
      ],
    }))
    .sort(
      (a, b) =>
        IntegrationAgentIdSchema.options.indexOf(a.id) -
        IntegrationAgentIdSchema.options.indexOf(b.id),
    );
}
