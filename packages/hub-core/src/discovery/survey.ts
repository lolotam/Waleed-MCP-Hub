import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import {
  DiscoverySnapshotSchema,
  type DiscoverySnapshot,
  type DiscoveryJob,
} from '@waleed/contracts';
import { discoverAgents, pendingAgents } from './agents.js';
import {
  compareSnapshots,
  inspectDockerProfile,
  inspectSource,
  object,
  parseDocument,
  strings,
  type PrivateCandidate,
} from './metadata.js';
import type { DiscoveryPorts, DiscoverySettings } from './ports.js';
import { recognizesChromeRecipe } from './chrome-recipe.js';

export function emptyDiscovery(settings: DiscoverySettings): DiscoverySnapshot {
  return {
    mode: settings.fixture ? 'fixture' : 'live',
    id: null,
    checkedAt: null,
    node: {
      version: settings.nodeVersion,
      platform: settings.platform,
      supported:
        /^24\./.test(settings.nodeVersion) && settings.platform === 'win32',
    },
    docker: {
      executable: null,
      cliVersion: null,
      gatewayVersion: null,
      engineVersion: null,
      state: 'not_checked',
      reason: 'none',
    },
    agents: pendingAgents(),
    pilot: {
      profileId: settings.profileId,
      state: 'not_checked',
      fingerprint: null,
      sourceStatus: 'not_checked',
      sourceFingerprint: null,
      drift: 'unknown',
      unmatchedSourceCount: 0,
      candidates: [],
      chrome: {
        launcherObserved: false,
        recipeRecognized: false,
        isolation: 'unknown',
        packagePinned: false,
      },
    },
  };
}
const localPipe = (value: string) =>
  /^npipe:\/\/\/\/\.\/pipe\/[a-z0-9._-]+$/i.test(value);
const localPath = (value: string) =>
  /^[a-z]:[\\/]/i.test(value) &&
  !/[\0\r\n]/.test(value) &&
  !value.slice(2).includes(':');
const version = (value: string): string | null =>
  /^v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(value.trim()) &&
  value.trim().length <= 60
    ? value.trim().replace(/^v/, '')
    : null;

export async function surveyEnvironment(
  ports: DiscoveryPorts,
  settings: DiscoverySettings,
  signal: AbortSignal,
  phase: (value: DiscoveryJob['phase']) => void,
  now: () => number = Date.now,
): Promise<DiscoverySnapshot> {
  const snapshot = emptyDiscovery(settings);
  snapshot.id = randomUUID();
  snapshot.checkedAt = new Date(now()).toISOString();
  phase('executables');
  snapshot.agents = await discoverAgents(
    ports,
    settings,
    signal,
    snapshot.checkedAt,
  );
  phase('configuration');
  let source: PrivateCandidate[] | null = null;
  const recipe = await ports.read(
    win32.join(settings.pilotDirectory, 'configuration', 'pilot.json'),
    signal,
  );
  if (recipe.status !== 'read') snapshot.pilot.sourceStatus = recipe.status;
  else {
    try {
      const document = parseDocument(recipe.text, 'json');
      const chrome = object(document.chrome);
      const arguments_ = strings(chrome?.arguments);
      const launcher = await ports.read(
        win32.join(settings.pilotDirectory, 'Start-Chrome.ps1'),
        signal,
      );
      snapshot.pilot.chrome.launcherObserved = launcher.status === 'read';
      snapshot.pilot.chrome.recipeRecognized =
        launcher.status === 'read' && recognizesChromeRecipe(launcher.text);
      if (
        typeof chrome?.package === 'string' &&
        /^chrome-devtools-mcp(?:@[a-z0-9.+-]+)?$/i.test(chrome.package) &&
        arguments_
      ) {
        const attach = arguments_.some((argument) =>
          /^--(?:browserURL|browser-url|autoConnect|auto-connect)(?:=|$)/i.test(
            argument,
          ),
        );
        snapshot.pilot.chrome.isolation = attach
          ? 'personal_attach'
          : snapshot.pilot.chrome.recipeRecognized &&
              arguments_.includes('--isolated')
            ? 'isolated'
            : 'unknown';
        snapshot.pilot.chrome.packagePinned =
          /^chrome-devtools-mcp@\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(
            chrome.package,
          );
        if (launcher.status === 'read')
          snapshot.pilot.candidates.push({
            id: 'native-chrome',
            name: 'Chrome DevTools',
            executionMode: 'native',
            origin: null,
            secretBindingCount: 0,
            verification: 'not_performed',
          });
      }
      const expectedSource = win32.join(
        settings.environment.XDG_CONFIG_HOME ||
          win32.join(settings.home, '.config'),
        'opencode',
        'mcp.json',
      );
      // Do not follow arbitrary filesystem pointers embedded in imported recipes.
      if (
        document.profile !== settings.profileId ||
        typeof document.sourceFile !== 'string' ||
        win32.normalize(document.sourceFile).toLowerCase() !==
          win32.normalize(expectedSource).toLowerCase()
      )
        snapshot.pilot.sourceStatus = 'unsafe';
      else {
        const read = await ports.read(expectedSource, signal);
        snapshot.pilot.sourceStatus = read.status;
        if (read.status === 'read') {
          snapshot.pilot.sourceFingerprint = read.fingerprint;
          try {
            source = inspectSource(read.text);
          } catch {
            snapshot.pilot.sourceStatus = 'invalid';
          }
        }
      }
    } catch {
      snapshot.pilot.sourceStatus = 'invalid';
    }
  }
  phase('docker');
  let dockerPaths: string[];
  try {
    dockerPaths = await ports.find(['docker'], signal);
  } catch {
    snapshot.docker.state = 'error';
    snapshot.docker.reason = 'probe_failed';
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  const executable = dockerPaths[0];
  snapshot.docker.executable = executable ?? null;
  if (!executable) {
    snapshot.docker.state = 'missing';
    snapshot.docker.reason = 'docker_missing';
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  if (win32.extname(executable).toLowerCase() !== '.exe') {
    snapshot.docker.state = 'unsupported';
    snapshot.docker.reason = 'probe_failed';
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  const environment: Record<string, string> = {};
  for (const key of [
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMW6432',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
  ])
    if (settings.environment[key])
      environment[key] = settings.environment[key]!;
  const pathValue = Object.entries(settings.environment).find(
    ([key]) => key.toLowerCase() === 'path',
  )?.[1];
  if (pathValue) environment.PATH = pathValue;
  if (environment.DOCKER_CONFIG && !localPath(environment.DOCKER_CONFIG)) {
    snapshot.docker.state = 'unsupported';
    snapshot.docker.reason = 'remote_context_not_allowed';
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  const cli = await ports.run(executable, ['--version'], environment, signal);
  snapshot.docker.cliVersion = cli.ok
    ? (/^Docker version (\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?),/i.exec(
        cli.output,
      )?.[1] ?? null)
    : null;
  let host: string | null = null;
  if (environment.DOCKER_HOST && !environment.DOCKER_CONTEXT)
    host = environment.DOCKER_HOST;
  else {
    const context = await ports.run(
      executable,
      ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
      environment,
      signal,
    );
    if (context.ok) {
      try {
        const value: unknown = JSON.parse(context.output);
        if (typeof value === 'string') host = value;
      } catch {
        /* Never echo a malformed endpoint. */
      }
    }
  }
  if (!host || !localPipe(host)) {
    snapshot.docker.state = 'unsupported';
    snapshot.docker.reason = 'remote_context_not_allowed';
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  environment.DOCKER_HOST = host;
  environment.DOCKER_CONTEXT = '';
  const gateway = await ports.run(
    executable,
    ['mcp', 'version'],
    environment,
    signal,
  );
  snapshot.docker.gatewayVersion = gateway.ok ? version(gateway.output) : null;
  if (!snapshot.docker.gatewayVersion) {
    snapshot.docker.state = 'unavailable';
    snapshot.docker.reason = 'gateway_unavailable';
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  if (snapshot.docker.gatewayVersion !== '0.44.2') {
    snapshot.docker.state = 'unsupported';
    snapshot.docker.reason = 'unsupported_gateway';
    snapshot.pilot.state = 'unsupported';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  const engine = await ports.run(
    executable,
    ['version', '--format', '{{.Server.Version}}'],
    environment,
    signal,
  );
  snapshot.docker.engineVersion = engine.ok ? version(engine.output) : null;
  if (!snapshot.docker.engineVersion) {
    snapshot.docker.state = 'unavailable';
    snapshot.docker.reason = 'engine_unavailable';
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  snapshot.docker.state = 'available';
  snapshot.docker.reason = 'none';
  phase('pilot');
  const list = await ports.run(
    executable,
    ['mcp', 'profile', 'list', '--format', 'json'],
    environment,
    signal,
  );
  if (!list.ok) {
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  try {
    const profiles: unknown = JSON.parse(list.output);
    if (
      !Array.isArray(profiles) ||
      profiles.length > 64 ||
      profiles.some(
        (item) => !object(item) || typeof object(item)?.id !== 'string',
      )
    )
      throw new Error('Unsupported profile list.');
    if (!profiles.some((item) => object(item)?.id === settings.profileId)) {
      snapshot.pilot.state = 'missing';
      return DiscoverySnapshotSchema.parse(snapshot);
    }
  } catch {
    snapshot.pilot.state = 'invalid';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  const profile = await ports.run(
    executable,
    ['mcp', 'profile', 'show', settings.profileId, '--format', 'json'],
    environment,
    signal,
  );
  if (!profile.ok) {
    snapshot.pilot.state = 'unavailable';
    return DiscoverySnapshotSchema.parse(snapshot);
  }
  try {
    const inspected = inspectDockerProfile(profile.output, settings.profileId);
    snapshot.pilot.state = 'observed';
    snapshot.pilot.fingerprint = inspected.fingerprint;
    snapshot.pilot.candidates.unshift(
      ...inspected.candidates.map((candidate) => candidate.public),
    );
    if (source) {
      const compared = compareSnapshots(inspected.candidates, source);
      snapshot.pilot.drift = compared.drift;
      snapshot.pilot.unmatchedSourceCount = compared.unmatched;
    }
  } catch {
    snapshot.pilot.state = 'unsupported';
  }
  return DiscoverySnapshotSchema.parse(snapshot);
}
