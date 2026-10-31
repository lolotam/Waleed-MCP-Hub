import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  createWindowsDiscoveryPorts,
  createDiscoveryService,
} from '@waleed/hub-core';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error(
    'Use Node 24 on Windows for this explicit read-only environment check.',
  );
const environment = Object.fromEntries(
  [
    'PATH',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMW6432',
    'CODEX_HOME',
    'GROK_HOME',
    'XDG_CONFIG_HOME',
    'OPENCODE_CONFIG',
    'CLAUDE_CONFIG_DIR',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
  ].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
);
const native = createWindowsDiscoveryPorts({
  workingDirectory: process.cwd(),
  environment,
});
const observed = new Map();
let profileRead;
const ports = {
  ...native,
  async read(path, signal) {
    const result = await native.read(path, signal);
    if (!observed.has(path))
      observed.set(
        path,
        result.status === 'read' ? result.fingerprint : result.status,
      );
    return result;
  },
  async run(executable, args, environment, signal) {
    const allowed =
      args.join(' ') === '--version' ||
      (args[0] === 'context' && args[1] === 'inspect') ||
      (args[0] === 'version' && args[1] === '--format') ||
      args.join(' ') === 'mcp version' ||
      args.join(' ') === 'mcp profile list --format json' ||
      args.slice(0, 3).join(' ') === 'mcp profile show';
    assert(allowed, 'Unexpected process command in read-only verification.');
    const result = await native.run(executable, args, environment, signal);
    if (args.slice(0, 3).join(' ') === 'mcp profile show' && result.ok)
      profileRead = {
        executable,
        args: [...args],
        environment: { ...environment },
        fingerprint: createHash('sha256').update(result.output).digest('hex'),
      };
    return result;
  },
};
const service = createDiscoveryService(ports, {
  home: homedir(),
  pilotDirectory:
    process.env.HUB_PILOT_DIR ?? 'E:\\Dev\\Tools_and_Utilities\\mcp-hub',
  profileId: 'waleed-mcp-hub-pilot',
  environment,
  nodeVersion: process.versions.node,
  platform: process.platform,
});
try {
  const job = service.start('local-read-only-check');
  await service.drain();
  assert.equal(
    service.job(job.id, 'local-read-only-check').state,
    'succeeded',
    'Discovery did not complete; no raw diagnostics are printed.',
  );
  const signal = new AbortController().signal;
  for (const [path, original] of observed) {
    const next = await native.read(path, signal);
    assert.equal(
      next.status === 'read' ? next.fingerprint : next.status,
      original,
      'An observed file changed during verification. No rollback was attempted.',
    );
  }
  if (profileRead) {
    const next = await native.run(
      profileRead.executable,
      profileRead.args,
      profileRead.environment,
      signal,
    );
    assert(
      next.ok &&
        createHash('sha256').update(next.output).digest('hex') ===
          profileRead.fingerprint,
      'Pilot snapshot changed during verification. No rollback was attempted.',
    );
  }
  const snapshot = service.snapshot();
  console.info(
    JSON.stringify(
      {
        readOnlyContentCheck: 'passed',
        observedFileCount: observed.size,
        node: snapshot.node,
        docker: {
          state: snapshot.docker.state,
          cliVersion: snapshot.docker.cliVersion,
          gatewayVersion: snapshot.docker.gatewayVersion,
          engineVersion: snapshot.docker.engineVersion,
          reason: snapshot.docker.reason,
        },
        agents: snapshot.agents.map((agent) => ({
          agentId: agent.agentId,
          detected: agent.detected,
          version: agent.version,
          versionSource: agent.versionSource,
          bindings: agent.configSummary,
        })),
        pilot: {
          state: snapshot.pilot.state,
          candidateCount: snapshot.pilot.candidates.length,
          sourceStatus: snapshot.pilot.sourceStatus,
          sourceComparison: snapshot.pilot.drift,
          chromeIsolation: snapshot.pilot.chrome.isolation,
        },
        limitations: [
          'No agent or connector was started.',
          'Versions without safe installed metadata remain unknown.',
          'Configuration scope/compatibility may be pending; no live MCP/auth verification.',
          'Adoption apply is unavailable.',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
}
