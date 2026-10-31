import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { DiscoveryPorts, DiscoverySettings } from '@waleed/hub-core';

export const settings: DiscoverySettings = {
  fixture: true,
  home: 'C:\\Synthetic',
  pilotDirectory: 'C:\\Synthetic\\pilot',
  profileId: 'synthetic-pilot',
  environment: {
    USERPROFILE: 'C:\\Synthetic',
    CODEX_HOME: 'C:\\Synthetic\\codex',
    GROK_HOME: 'C:\\Synthetic\\grok',
    PATH: 'C:\\Synthetic\\bin',
    SYNTHETIC_PRIVATE_KEY: 'not-forwarded',
  },
  nodeVersion: '24.21.0',
  platform: 'win32',
};
export const privateMarker = [
  'SYNTHETIC',
  'DISCOVERY',
  'SENSITIVE',
  'VALUE',
].join('-');
export function discoveryFixture() {
  const files = new Map<string, string>();
  const key = (path: string) => win32.normalize(path).toLowerCase();
  const put = (path: string, value: unknown) =>
    files.set(
      key(path),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const gateway = {
    command: 'docker.exe',
    args: ['mcp', 'gateway', 'run', '--profile', settings.profileId],
  };
  const chrome = {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-File',
      win32.join(settings.pilotDirectory, 'Start-Chrome.ps1'),
    ],
  };
  const source = {
    mcpServers: {
      'fixture-remote': {
        url: 'https://example.test/mcp',
        headers: { Authorization: privateMarker },
      },
      'fixture-image': { image: 'synthetic-image:1', command: [privateMarker] },
    },
    servers: {
      'unused-native': {
        command: 'never-run.exe',
        args: ['SYNTHETIC-NOT-EXECUTED'],
      },
    },
  };
  put(win32.join(settings.pilotDirectory, 'configuration', 'pilot.json'), {
    profile: settings.profileId,
    sourceFile: win32.join(settings.home, '.config', 'opencode', 'mcp.json'),
    chrome: { package: 'chrome-devtools-mcp@1.2.3', arguments: ['--isolated'] },
  });
  put(
    win32.join(settings.pilotDirectory, 'Start-Chrome.ps1'),
    String.raw`$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'configuration\pilot.json') -Raw | ConvertFrom-Json
$env:CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = '1'
$env:CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = '1'
$chromeArgs = @('-y', $config.chrome.package) + @($config.chrome.arguments)
& npx.cmd @chromeArgs
exit $LASTEXITCODE`,
  );
  put(win32.join(settings.home, '.config', 'opencode', 'mcp.json'), source);
  put(
    win32.join(settings.home, '.config', 'opencode', 'opencode.jsonc'),
    '{ // synthetic comment\n"mcp":{"servers":' +
      JSON.stringify({
        'hub-pilot': {
          ...gateway,
          command: [gateway.command, ...gateway.args],
          type: 'local',
        },
        'hub-chrome': {
          ...chrome,
          command: [chrome.command, ...chrome.args],
          type: 'local',
        },
        unrelated: {
          command: ['never-run.exe'],
          environment: { API_KEY: privateMarker },
        },
      }) +
      '},"providers":{"do-not-expand":"{file:C:/Synthetic/.credentials.json}"},}',
  );
  put(
    win32.join(settings.environment.CODEX_HOME!, 'config.toml'),
    String.raw`# Synthetic TOML; preserved verbatim.
[mcp_servers.hub-pilot]
command = 'docker.exe'
args = ['mcp', 'gateway', 'run', '--profile', 'synthetic-pilot']
[mcp_servers.hub-chrome]
command = 'powershell.exe'
args = ['-NoProfile', '-File', 'C:\Synthetic\pilot\Start-Chrome.ps1']
[mcp_servers.node_repl]
command = 'never-run.exe'
`,
  );
  put(win32.join(settings.home, '.claude.json'), {
    mcpServers: {},
    oauthAccount: { ignored: privateMarker },
  });
  put(win32.join(settings.home, '.claude', 'settings.json'), {
    deniedMcpServers: [{ serverName: 'rube' }, { serverName: 'byterover' }],
  });
  put(win32.join(settings.home, '.claude', '.credentials.json'), {
    credential: privateMarker,
  });
  for (const name of [
    '@opencode/cli',
    '@openai/codex',
    '@anthropic-ai/claude-code',
    '@kilocode/cli',
    '@moonshot-ai/kimi-code',
  ])
    put(
      win32.join('C:\\Synthetic\\bin', 'node_modules', name, 'package.json'),
      { name, version: '1.2.3', scripts: { postinstall: 'never-execute' } },
    );
  const profile = {
    version: 1,
    id: settings.profileId,
    name: 'Synthetic pilot',
    servers: [
      {
        type: 'remote',
        endpoint: 'https://example.test/mcp',
        snapshot: {
          server: {
            name: 'fixture-remote',
            remote: {
              url: 'https://example.test/mcp',
              headers: { Authorization: privateMarker },
            },
            secrets: [{ name: 'synthetic-reference' }],
          },
        },
      },
      {
        type: 'image',
        image: 'synthetic-image:1',
        snapshot: {
          server: {
            name: 'fixture-image',
            image: 'synthetic-image:1',
            command: [privateMarker],
            env: { PRIVATE: privateMarker },
            secrets: [{ name: 'synthetic-reference' }],
          },
        },
      },
    ],
    secrets: { omitted: privateMarker },
  };
  const calls: Array<{
    executable: string;
    arguments: string[];
    environment: Record<string, string>;
  }> = [];
  const reads: string[] = [];
  const ports: DiscoveryPorts = {
    async find(names) {
      return names.map((name) =>
        win32.join(
          'C:\\Synthetic\\bin',
          name + (['docker', 'agy', 'grok'].includes(name) ? '.exe' : '.cmd'),
        ),
      );
    },
    async read(path) {
      reads.push(path);
      const text = files.get(key(path));
      return text === undefined
        ? { status: 'missing' }
        : {
            status: 'read',
            text,
            fingerprint: createHash('sha256').update(text).digest('hex'),
          };
    },
    async run(executable, args, environment) {
      calls.push({
        executable,
        arguments: [...args],
        environment: { ...environment },
      });
      const command = args.join(' ');
      if (command === '--version')
        return { ok: true, output: 'Docker version 29.9.2, build synthetic' };
      if (command.startsWith('context inspect'))
        return {
          ok: true,
          output: JSON.stringify('npipe:////./pipe/synthetic-engine'),
        };
      if (command === 'mcp version') return { ok: true, output: 'v0.44.2' };
      if (command.startsWith('version --format'))
        return { ok: true, output: '29.9.2' };
      if (command === 'mcp profile list --format json')
        return { ok: true, output: JSON.stringify([profile]) };
      if (command === `mcp profile show ${settings.profileId} --format json`)
        return { ok: true, output: JSON.stringify(profile) };
      throw new Error('Unexpected command in read-only fixture.');
    },
  };
  return {
    ports,
    files,
    reads,
    calls,
    profile,
    source,
    put,
    settings: structuredClone(settings),
  };
}
