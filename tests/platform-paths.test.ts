import { expect, it } from 'vitest';
import {
  IntegrationAgentIdSchema,
  type IntegrationAgentId,
} from '@waleed/contracts';
import {
  platformAgentTargets,
  platformDirectories,
  platformPathKey,
  windowsAgentTargets,
} from '@waleed/hub-core';

const ids = IntegrationAgentIdSchema.options;
it.each(['win32', 'darwin', 'linux'] as const)(
  '%s resolves all 17 agent scopes with native separators and the correct application/config roots',
  (platform) => {
    const home =
      platform === 'win32' ? 'C:\\Users\\Synthetic' : '/home/synthetic';
    const targets = platformAgentTargets(platform, home, {}),
      separator = platform === 'win32' ? '\\' : '/';
    const join = (...parts: string[]) => parts.join(separator);
    const app =
      platform === 'win32'
        ? join(home, 'AppData', 'Roaming')
        : platform === 'darwin'
          ? join(home, 'Library', 'Application Support')
          : join(home, '.config');
    const config = join(home, '.config');
    const expected: Record<IntegrationAgentId, string> = {
      opencode: join(config, 'opencode', 'opencode.json'),
      codex: join(home, '.codex', 'config.toml'),
      'claude-desktop': join(app, 'Claude', 'claude_desktop_config.json'),
      claude: join(home, '.claude.json'),
      antigravity: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      vscode: join(app, 'Code', 'User', 'mcp.json'),
      cursor: join(home, '.cursor', 'mcp.json'),
      kimi: join(home, '.kimi-code', 'mcp.json'),
      kilo: join(config, 'kilo', 'kilo.json'),
      windsurf: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      cline: join(
        app,
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      ),
      'roo-code': join(
        app,
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'cline_mcp_settings.json',
      ),
      zed:
        platform === 'win32'
          ? join(app, 'Zed', 'settings.json')
          : join(config, 'zed', 'settings.json'),
      'gemini-cli': join(home, '.gemini', 'settings.json'),
      goose:
        platform === 'win32'
          ? join(app, 'Block', 'goose', 'config', 'config.yaml')
          : join(config, 'goose', 'config.yaml'),
      jetbrains: join(app, 'JetBrains', 'mcp.json'),
      warp: join(home, '.warp', '.mcp.json'),
    };
    expect(targets.map((target) => target.id)).toEqual(ids);
    for (const target of targets) {
      expect(target.paths[0], target.id).toBe(expected[target.id]);
      if (platform !== 'win32')
        for (const path of target.paths) expect(path).not.toContain('\\');
    }
    if (platform === 'win32')
      expect(targets).toEqual(windowsAgentTargets(home, {}));
    else
      expect(
        targets.find((target) => target.id === 'jetbrains')!.requireExisting,
      ).toBe(true);
    if (platform === 'linux')
      expect(
        targets.find((target) => target.id === 'claude-desktop')!,
      ).toMatchObject({
        requireExisting: true,
        reconnect: expect.stringContaining('No official Linux'),
      });
  },
);
it('honors absolute XDG and runtime overrides, ignores relative XDG values, and isolates approved package receipts under runtime data', () => {
  const linux = platformDirectories({
    platform: 'linux',
    home: '/home/عربي',
    environment: {
      XDG_CONFIG_HOME: '/settings',
      XDG_DATA_HOME: '/data',
      XDG_CACHE_HOME: '/cache',
    },
  });
  expect(linux).toMatchObject({
    config: '/settings',
    runtime: '/data/waleed-mcp-hub',
    cache: '/cache/waleed-mcp-hub',
    packages: '/data/waleed-mcp-hub/packages',
  });
  const mac = platformDirectories({
    platform: 'darwin',
    home: '/Users/person',
    environment: { XDG_CONFIG_HOME: '/settings', HUB_DATA_DIR: '/private/hub' },
  });
  expect(mac).toMatchObject({
    config: '/settings',
    applicationSupport: '/Users/person/Library/Application Support',
    runtime: '/private/hub',
    cache: '/Users/person/Library/Caches/WaleedMcpHub',
    packages: '/private/hub/packages',
  });
  expect(
    platformDirectories({
      platform: 'linux',
      home: '/home/person',
      environment: {
        XDG_CONFIG_HOME: 'relative',
        XDG_DATA_HOME: 'relative',
        XDG_CACHE_HOME: 'relative',
      },
    }).runtime,
  ).toBe('/home/person/.local/share/waleed-mcp-hub');
  expect(() =>
    platformDirectories({
      platform: 'linux',
      home: '/home/person',
      environment: { HUB_DATA_DIR: 'relative' },
    }),
  ).toThrow();
  const targets = platformAgentTargets('linux', '/home/person', {
    XDG_CONFIG_HOME: '/settings',
    CODEX_HOME: '/codex',
    KIMI_CODE_HOME: '/kimi',
    OPENCODE_CONFIG: '/opencode/one.json',
  });
  for (const [id, path] of [
    ['codex', '/codex/config.toml'],
    ['kimi', '/kimi/mcp.json'],
    ['opencode', '/opencode/one.json'],
    ['vscode', '/settings/Code/User/mcp.json'],
    ['goose', '/settings/goose/config.yaml'],
  ])
    expect(targets.find((target) => target.id === id)!.paths[0]).toBe(path);
});
it('retains Windows runtime locations and case-insensitive comparisons without case-folding POSIX scopes', () => {
  expect(
    platformDirectories({
      platform: 'win32',
      home: 'C:\\Users\\S',
      environment: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' },
    }),
  ).toMatchObject({
    config: 'D:\\Roaming',
    local: 'D:\\Local',
    runtime: 'D:\\Local\\WaleedMcpHub',
    packages: 'D:\\Local\\WaleedMcpHub\\packages',
  });
  expect(
    platformDirectories({ platform: 'win32', home: 'C:\\Users\\S' }).runtime,
  ).toBe('C:\\Users\\S\\.local\\share\\WaleedMcpHub');
  expect(platformPathKey('C:/Users/S/config/../mcp.json', 'win32')).toBe(
    platformPathKey('c:\\users\\s\\mcp.json', 'win32'),
  );
  expect(platformPathKey('/home/S/config/../mcp.json', 'linux')).toBe(
    '/home/S/mcp.json',
  );
  expect(platformPathKey('/home/S/mcp.json', 'darwin')).not.toBe(
    platformPathKey('/home/s/mcp.json', 'darwin'),
  );
});
