import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryService, emptyState } from '@waleed/hub-core';
import { surveyEnvironment } from '../packages/hub-core/src/discovery/survey.js';
import { inspectAgentFile } from '../packages/hub-core/src/discovery/metadata.js';
import {
  discoveryFixture,
  privateMarker,
  settings,
} from './fixtures/discovery.js';

const signal = () => new AbortController().signal;
async function scan(fixture = discoveryFixture()) {
  return surveyEnvironment(
    fixture.ports,
    fixture.settings,
    signal(),
    () => undefined,
  );
}

describe('read-only environment discovery', () => {
  it('retains healthy observations when Docker executable resolution fails', async () => {
    const fixture = discoveryFixture();
    const find = fixture.ports.find;
    fixture.ports.find = async (names, token) => {
      if (names[0] === 'docker') throw new Error(privateMarker);
      return find(names, token);
    };
    const snapshot = await scan(fixture);
    expect(snapshot.docker).toMatchObject({
      state: 'error',
      reason: 'probe_failed',
    });
    expect(snapshot.agents.every((agent) => agent.detected)).toBe(true);
    expect(
      snapshot.pilot.candidates.some(
        (candidate) => candidate.executionMode === 'native',
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
  });
  it('discovers eight distinct targets and installed versions without executing agents or copying sensitive config', async () => {
    const fixture = discoveryFixture();
    const before = JSON.stringify([...fixture.files]);
    const snapshot = await scan(fixture);
    expect(snapshot.agents).toHaveLength(8);
    expect(new Set(snapshot.agents.map((agent) => agent.agentId)).size).toBe(8);
    expect(
      snapshot.agents.every(
        (agent) =>
          agent.detected === true &&
          agent.compatibility === 'pending' &&
          agent.registered === null &&
          agent.verification === 'not_performed',
      ),
    ).toBe(true);
    expect(
      snapshot.agents.find((agent) => agent.agentId === 'opencode'),
    ).toMatchObject({
      aliases: ['opencode', 'opencode2'],
      version: '1.2.3',
      versionSource: 'manifest',
      configSummary: 'matching',
    });
    expect(
      snapshot.agents.find((agent) => agent.agentId === 'kilo')?.aliases,
    ).toEqual(['kilo', 'kilocode']);
    expect(
      snapshot.agents.find((agent) => agent.agentId === 'codex'),
    ).toMatchObject({ configSummary: 'matching', versionSource: 'manifest' });
    expect(fixture.reads).toContain(
      win32.join(settings.environment.CODEX_HOME!, 'config.toml'),
    );
    expect(
      fixture.reads.some((path) => /(?:credentials|auth)\.json$/i.test(path)),
    ).toBe(false);
    expect(
      fixture.calls.every((call) => call.executable.endsWith('docker.exe')),
    ).toBe(true);
    expect(
      fixture.calls.some(
        (call) =>
          call.arguments.includes('gateway') ||
          call.arguments.includes('tools') ||
          call.arguments.includes('add') ||
          call.arguments.includes('run'),
      ),
    ).toBe(false);
    expect(
      fixture.calls.every(
        (call) => !('SYNTHETIC_PRIVATE_KEY' in call.environment),
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
    expect(JSON.stringify(snapshot)).not.toContain('node_repl');
    expect(JSON.stringify(snapshot)).not.toContain('deniedMcpServers');
    expect(JSON.stringify([...fixture.files])).toBe(before);
    expect(snapshot.docker).toMatchObject({
      state: 'available',
      gatewayVersion: '0.44.2',
      engineVersion: '29.9.2',
    });
    expect(snapshot.pilot).toMatchObject({
      state: 'observed',
      drift: 'matching',
      unmatchedSourceCount: 1,
      chrome: {
        launcherObserved: true,
        isolation: 'isolated',
        packagePinned: true,
      },
    });
    expect(snapshot.pilot.candidates).toHaveLength(3);
  });
  it('reports each missing executable rather than duplicating aliases or pretending they are connected', async () => {
    const fixture = discoveryFixture();
    fixture.ports.find = async () => [];
    const snapshot = await scan(fixture);
    expect(
      snapshot.agents.every(
        (agent) => agent.detected === false && agent.resolution === 'missing',
      ),
    ).toBe(true);
    expect(snapshot.docker).toMatchObject({
      state: 'missing',
      reason: 'docker_missing',
    });
    expect(snapshot.pilot.state).toBe('unavailable');
  });
  it('shows Docker stopped as degraded and retains the native exception and other agent observations', async () => {
    const fixture = discoveryFixture();
    const run = fixture.ports.run;
    fixture.ports.run = async (...args) =>
      args[1][0] === 'version' ? { ok: false, output: '' } : run(...args);
    const snapshot = await scan(fixture);
    expect(snapshot.docker).toMatchObject({
      state: 'unavailable',
      reason: 'engine_unavailable',
    });
    expect(
      snapshot.pilot.candidates.some(
        (candidate) => candidate.executionMode === 'native',
      ),
    ).toBe(true);
    expect(
      snapshot.agents.find((agent) => agent.agentId === 'codex')?.detected,
    ).toBe(true);
    expect(fixture.calls.some((call) => call.arguments.includes('show'))).toBe(
      false,
    );
  });
  it('refuses unknown gateway versions before reading profile snapshots', async () => {
    const fixture = discoveryFixture();
    const run = fixture.ports.run;
    fixture.ports.run = async (...args) =>
      args[1].join(' ') === 'mcp version'
        ? { ok: true, output: 'v9.0.0' }
        : run(...args);
    expect((await scan(fixture)).docker).toMatchObject({
      state: 'unsupported',
      reason: 'unsupported_gateway',
    });
    expect(
      fixture.calls.some((call) => call.arguments.includes('profile')),
    ).toBe(false);
  });
  it.each([
    'ssh://user@host.test',
    'tcp://127.0.0.1:2375',
    'npipe:////other-host/pipe/docker_engine',
  ])(
    'never probes a nonlocal or unverified Docker endpoint: %s',
    async (host) => {
      const fixture = discoveryFixture();
      const run = fixture.ports.run;
      fixture.ports.run = async (...args) =>
        args[1][0] === 'context'
          ? { ok: true, output: JSON.stringify(host) }
          : run(...args);
      expect((await scan(fixture)).docker).toMatchObject({
        state: 'unsupported',
        reason: 'remote_context_not_allowed',
      });
      expect(
        fixture.calls.some(
          (call) =>
            call.arguments.includes('mcp') || call.arguments[0] === 'version',
        ),
      ).toBe(false);
    },
  );
  it('distinguishes invalid profile reads from missing profiles and does not fabricate empty success', async () => {
    for (const output of ['broken JSON', JSON.stringify([])]) {
      const fixture = discoveryFixture();
      const run = fixture.ports.run;
      fixture.ports.run = async (...args) =>
        args[1].join(' ') === 'mcp profile list --format json'
          ? { ok: true, output }
          : run(...args);
      expect((await scan(fixture)).pilot.state).toBe(
        output === 'broken JSON' ? 'invalid' : 'missing',
      );
    }
  });
  it('detects source/profile drift while keeping credential values private', async () => {
    const fixture = discoveryFixture();
    fixture.source.mcpServers['fixture-remote'].url =
      'https://example.test/changed';
    fixture.put(
      win32.join(settings.home, '.config', 'opencode', 'mcp.json'),
      fixture.source,
    );
    const snapshot = await scan(fixture);
    expect(snapshot.pilot.drift).toBe('different');
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
  });
  it('detects changed image command arrays but treats credential URLs as an unknown comparison', async () => {
    const fixture = discoveryFixture();
    fixture.source.mcpServers['fixture-image'].command = [
      'different-synthetic-command',
    ];
    fixture.put(
      win32.join(settings.home, '.config', 'opencode', 'mcp.json'),
      fixture.source,
    );
    expect((await scan(fixture)).pilot.drift).toBe('different');
    const urls = discoveryFixture();
    urls.source.mcpServers['fixture-remote'].url =
      'https://user:pass@example.test/mcp?token=' + privateMarker;
    urls.put(
      win32.join(settings.home, '.config', 'opencode', 'mcp.json'),
      urls.source,
    );
    const snapshot = await scan(urls);
    expect(snapshot.pilot.drift).toBe('unknown');
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
  });
  it('does not infer isolated Chrome behavior from a recipe file if the launcher was changed', async () => {
    const fixture = discoveryFixture();
    fixture.put(
      win32.join(settings.pilotDirectory, 'Start-Chrome.ps1'),
      'Write-Output SYNTHETIC-UNKNOWN-LAUNCHER',
    );
    const snapshot = await scan(fixture);
    expect(snapshot.pilot.chrome).toMatchObject({
      launcherObserved: true,
      recipeRecognized: false,
      isolation: 'unknown',
    });
    const service = createDiscoveryService(fixture.ports, fixture.settings);
    service.start('a');
    await service.drain();
    expect(service.preview(emptyState(), false).conflicts).toContain(
      'unknown_native_launcher',
    );
    await service.close();
  });
  it('does not follow arbitrary file pointers or expand file/environment substitutions', async () => {
    const fixture = discoveryFixture();
    fixture.put(
      win32.join(settings.pilotDirectory, 'configuration', 'pilot.json'),
      {
        profile: settings.profileId,
        sourceFile: 'C:\\Synthetic\\.claude\\.credentials.json',
      },
    );
    const snapshot = await scan(fixture);
    expect(snapshot.pilot.sourceStatus).toBe('unsafe');
    expect(
      fixture.reads.some((path) => path.includes('.credentials.json')),
    ).toBe(false);
  });
  it('keeps malformed/inaccessible/oversized file states distinct without hiding healthy agents', async () => {
    for (const status of ['inaccessible', 'too_large', 'unsafe'] as const) {
      const fixture = discoveryFixture();
      const read = fixture.ports.read;
      fixture.ports.read = async (path, token) =>
        path.endsWith('config.toml') ? { status } : read(path, token);
      const snapshot = await scan(fixture);
      expect(
        snapshot.agents.find((agent) => agent.agentId === 'codex'),
      ).toMatchObject({
        configSummary: 'error',
        configFiles: [expect.objectContaining({ status })],
      });
      expect(
        snapshot.agents.find((agent) => agent.agentId === 'opencode')
          ?.configSummary,
      ).toBe('matching');
    }
  });
  it('treats a different unrelated gateway as unrelated, but detects a conflicting managed hub name', () => {
    const inspect = (name: string) =>
      inspectAgentFile(
        'C:\\Synthetic\\config.toml',
        {
          status: 'read',
          fingerprint: 'a'.repeat(64),
          text: `[mcp_servers.${name}]\ncommand='docker.exe'\nargs=['mcp','gateway','run','--profile','other-profile']`,
        },
        'toml',
        'codex',
        settings.profileId,
        'C:\\Synthetic\\pilot\\Start-Chrome.ps1',
      );
    expect(inspect('unrelated').binding).toBe('absent');
    expect(inspect('hub-pilot').binding).toBe('conflict');
  });
  it('recognizes the existing fixed pilot wrapper pointer without evaluating PowerShell', () => {
    const file = inspectAgentFile(
      'C:\\Synthetic\\config.json',
      {
        status: 'read',
        fingerprint: 'a'.repeat(64),
        text: JSON.stringify({
          mcpServers: {
            'hub-pilot': {
              command: 'powershell.exe',
              args: [
                '-NoProfile',
                '-File',
                'C:\\Synthetic\\pilot\\Start-Pilot.ps1',
              ],
            },
            'hub-chrome': {
              command: 'powershell.exe',
              args: [
                '-NoProfile',
                '-File',
                'C:\\Synthetic\\pilot\\Start-Chrome.ps1',
              ],
            },
          },
        }),
      },
      'jsonc',
      'mcpServers',
      settings.profileId,
      'C:\\Synthetic\\pilot\\Start-Chrome.ps1',
    );
    expect(file).toMatchObject({
      binding: 'matching',
      hubEntries: ['gateway', 'chrome'],
    });
  });
  it('reports unsupported legacy OpenCode layers rather than calling them an empty configuration', async () => {
    const file = inspectAgentFile(
      'C:\\Synthetic\\opencode.json',
      {
        status: 'read',
        fingerprint: 'a'.repeat(64),
        text: JSON.stringify({
          mcp: { unrelated: { type: 'local', command: ['never-run'] } },
        }),
      },
      'jsonc',
      'opencode',
      settings.profileId,
      'C:\\Synthetic\\pilot\\Start-Chrome.ps1',
    );
    expect(file).toMatchObject({
      status: 'unsupported',
      binding: 'unknown',
      entryCount: null,
    });
    const fixture = discoveryFixture();
    fixture.put(
      win32.join(settings.home, '.config', 'opencode', 'opencode.jsonc'),
      JSON.stringify({
        mcp: { unrelated: { type: 'local', command: ['never-run'] } },
      }),
    );
    expect(
      (await scan(fixture)).agents.find((agent) => agent.agentId === 'opencode')
        ?.configSummary,
    ).toBe('pending');
  });
  it('rejects a TOML date value where an MCP table is required', () => {
    const file = inspectAgentFile(
      'C:\\Synthetic\\config.toml',
      {
        status: 'read',
        fingerprint: 'a'.repeat(64),
        text: 'mcp_servers = 1979-05-27T07:32:00Z',
      },
      'toml',
      'codex',
      settings.profileId,
      'C:\\Synthetic\\pilot\\Start-Chrome.ps1',
    );
    expect(file).toMatchObject({
      status: 'invalid',
      binding: 'unknown',
      entryCount: null,
    });
  });
});

describe('bounded discovery jobs and adoption previews', () => {
  it('does nothing until started, scopes job access, and previews with no mutation/apply capability', async () => {
    const fixture = discoveryFixture();
    const service = createDiscoveryService(fixture.ports, fixture.settings);
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.calls).toHaveLength(0);
    expect(service.snapshot().checkedAt).toBeNull();
    const job = service.start('a');
    expect(() => service.job(job.id, 'b')).toThrow();
    expect(() => service.start('a')).toThrow();
    await service.drain();
    expect(service.job(job.id, 'a').state).toBe('succeeded');
    const preview = service.preview(emptyState(), false);
    expect(preview).toMatchObject({
      applySupported: false,
      freshness: 'snapshot_only',
      expectedRevision: 0,
    });
    expect(preview.candidates).toHaveLength(3);
    expect(preview.effects).toContain('secrets_not_copied');
    expect(service.preview(emptyState(), true).conflicts).toContain(
      'unresolved_registry_operation',
    );
    expect(JSON.stringify(preview)).not.toContain(privateMarker);
    await service.close();
  });
  it('cancels only the owned scan and keeps the previous successful snapshot', async () => {
    let now = Date.now();
    const fixture = discoveryFixture();
    const service = createDiscoveryService(
      fixture.ports,
      fixture.settings,
      () => now,
    );
    service.start('a');
    await service.drain();
    const previous = service.snapshot();
    now += 5001;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.ports.run = async (_executable, _args, _environment, token) => {
      if (token.aborted) return { ok: false, output: '' };
      entered();
      await new Promise<void>((resolve) =>
        token.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { ok: false, output: '' };
    };
    const job = service.start('a');
    await started;
    expect(() => service.cancel(job.id, 'b')).toThrow();
    service.cancel(job.id, 'a');
    await service.drain();
    expect(service.job(job.id, 'a').state).toBe('cancelled');
    expect(service.snapshot()).toEqual(previous);
    await service.close();
  });
  it('bounds stalled scans by a deadline without publishing partial success', async () => {
    vi.useFakeTimers();
    const fixture = discoveryFixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.ports.run = async (_exe, _args, _env, token) => {
      if (!token.aborted) {
        entered();
        await new Promise<void>((resolve) =>
          token.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return { ok: false, output: '' };
    };
    const service = createDiscoveryService(fixture.ports, fixture.settings);
    try {
      const job = service.start('a');
      await started;
      await vi.advanceTimersByTimeAsync(60_001);
      await service.drain();
      expect(service.job(job.id, 'a')).toMatchObject({
        state: 'failed',
        reason: 'deadline',
      });
      expect(service.snapshot().id).toBeNull();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });
});
