// Explicit real Docker metadata writes + synthetic native MCP clients only.
// Not part of CI; no existing/adopted profile is ever selected for mutation.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createLifecycle,
  createMaterializer,
  createWindowsDiscoveryPorts,
  createWindowsProcessRunner,
  managedFiles,
  dockerCommand,
  dockerProfiles,
  openStateStore,
  openSafetyLedger,
  definitionHash,
  managedProfileId,
} from '@waleed/hub-core';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error('Use Node 24 on Windows.');
const directory = await mkdtemp(join(tmpdir(), 'hub-p5-verify-'));
const environment = Object.fromEntries(
  [
    'PATH',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMW6432',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
const [executable] = await createWindowsDiscoveryPorts({
  workingDirectory: directory,
  environment,
}).find(['docker'], AbortSignal.timeout(3000));
assert(
  executable?.toLowerCase().endsWith('.exe'),
  'A local Docker executable is required.',
);
const command = dockerCommand(
  await createWindowsProcessRunner({
    allowedExecutables: [executable],
    workingDirectory: directory,
  }),
  executable,
  environment,
);
const files = managedFiles({
  runtime: join(directory, 'managed'),
  catalog: join(
    environment.DOCKER_CONFIG ?? join(homedir(), '.docker'),
    'mcp',
    'catalogs',
  ),
});
const docker = dockerProfiles(command, files);
const store = await openStateStore(directory);
const safety = await openSafetyLedger(directory);
const hub = createLifecycle(store, Date.now, safety, {
  materializer: createMaterializer({
    files,
    docker,
    nodeExecutable: process.execPath,
    registryPath: join(directory, 'state.json'),
    launcherModuleUrl: new URL(
      '../packages/hub-core/dist/runtime/launcher.js',
      import.meta.url,
    ).href,
  }),
});
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
let successful = false;
async function apply(operation) {
  const preview = await hub.preview(
    { expectedRevision: (await hub.inventory()).revision, ...operation },
    'explicit-p5-verification',
  );
  const job = await hub.apply(preview.id, 'explicit-p5-verification');
  await hub.drain();
  const finished = hub.job(job.id, 'explicit-p5-verification');
  assert.equal(
    finished.state,
    'succeeded',
    'Disposable operation failed. No raw diagnostics printed.',
  );
  return finished.resultId;
}
try {
  const pilotBefore = fingerprint(
    await command.run(
      ['mcp', 'profile', 'show', 'waleed-mcp-hub-pilot', '--format', 'json'],
      AbortSignal.timeout(15_000),
    ),
  );
  const common = {
    description: '',
    enabled: true,
    environmentLiterals: {},
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
  };
  const definitions = [
    {
      ...common,
      id: 'synthetic-remote',
      name: 'Synthetic remote — never contacted',
      executionMode: 'remote',
      transport: 'streamable_http',
      endpoint: 'https://example.test/mcp',
    },
    {
      ...common,
      id: 'synthetic-image',
      name: 'Synthetic image — never pulled',
      executionMode: 'docker',
      transport: 'stdio',
      image: 'wmh-synthetic-never-run:0',
      command: ['never-execute'],
      arguments: [],
    },
    {
      ...common,
      id: 'synthetic-native',
      name: 'Synthetic native stdio',
      executionMode: 'native',
      transport: 'stdio',
      executable: process.execPath,
      arguments: [
        fileURLToPath(
          new URL('../tests/fixtures/mcp-stdio.mjs', import.meta.url),
        ),
        join(directory, 'peer.json'),
        'healthy',
        'A B',
        'عربي',
        '"quotes"',
        '$(inert); & literal',
      ],
    },
  ];
  await apply({ kind: 'create_connectors', definitions });
  for (const connector of (await hub.inventory()).connectors)
    await apply({
      kind: 'approve_connector',
      connectorId: connector.id,
      expectedConnectorRevision: connector.revision,
      definitionHash: definitionHash(connector),
      approveExecution: true,
    });
  const profileId = await apply({
    kind: 'create_profile',
    name: `P5 disposable ${randomUUID()}`,
    description: '',
    connectorIds: definitions.map((item) => item.id),
  });
  assert(profileId);
  const dockerId = managedProfileId(profileId);
  await apply({ kind: 'materialize_profile', profileId });
  const record = (await hub.inventory()).materializations.find(
    (item) => item.profileId === profileId,
  );
  assert(record);
  assert.equal(
    JSON.parse(await docker.read(dockerId, AbortSignal.timeout(15_000))).servers
      .length,
    2,
  );
  const entry = record.files.find(
    (file) => file.scope === 'runtime' && file.name.endsWith('.mjs'),
  );
  assert(entry);
  const clients = [
    new Client(
      { name: 'fixture-agent-one', version: '1.0.0' },
      { capabilities: {} },
    ),
    new Client(
      { name: 'fixture-agent-two', version: '1.0.0' },
      { capabilities: {} },
    ),
  ];
  try {
    await Promise.all(
      clients.map((client) =>
        client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [files.path('runtime', entry.name)],
            env: { SYNTHETIC_PROVIDER_SECRET: 'NOT-FOR-THE-TARGET' },
            stderr: 'pipe',
          }),
          { timeout: 10_000 },
        ),
      ),
    );
    assert.notEqual(
      clients[0].getServerVersion().name,
      clients[1].getServerVersion().name,
      'Native clients were not independent.',
    );
    for (const client of clients) {
      assert.equal((await client.listTools()).tools.length, 1);
      await client.listResources();
      await client.listPrompts();
    }
  } finally {
    await Promise.all(
      clients.map((client) => client.close().catch(() => undefined)),
    );
  }
  const peer = JSON.parse(await readFile(join(directory, 'peer.json'), 'utf8'));
  assert(!peer.methods.includes('tools/call'));
  assert.equal(peer.inheritedSecret, null);
  assert.deepEqual(peer.arguments, [
    'A B',
    'عربي',
    '"quotes"',
    '$(inert); & literal',
  ]);
  await apply({
    kind: 'set_connector_enabled',
    connectorId: 'synthetic-image',
    enabled: false,
  });
  await apply({ kind: 'materialize_profile', profileId });
  assert.equal(
    JSON.parse(await docker.read(dockerId, AbortSignal.timeout(15_000))).servers
      .length,
    1,
  );
  await apply({ kind: 'dematerialize_profile', profileId });
  assert.equal(await docker.read(dockerId, AbortSignal.timeout(15_000)), null);
  for (const file of record.files)
    assert.equal(await files.read(file.scope, file.name), null);
  await apply({ kind: 'remove_profile', profileId });
  assert.equal(
    fingerprint(
      await command.run(
        ['mcp', 'profile', 'show', 'waleed-mcp-hub-pilot', '--format', 'json'],
        AbortSignal.timeout(15_000),
      ),
    ),
    pilotBefore,
    'Existing pilot changed; no rollback of it was attempted.',
  );
  successful = true;
  console.info(
    JSON.stringify(
      {
        disposableProfile: 'created_read_back_updated_removed',
        ownedFiles: record.files.length,
        nativeClients: 'two independent stdio processes',
        argvAndEnvironmentIsolation: 'passed',
        toolCalls: 0,
        imagePulls: 0,
        upstreamRequests: 0,
        existingPilotFingerprint: 'unchanged',
      },
      null,
      2,
    ),
  );
} finally {
  await hub.close();
  await safety.close();
  await store.close();
  if (successful)
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  else
    console.error(
      `Disposable verification incomplete. Only its own recovery state was retained at ${directory}; inspect its journal and generated wmh profile before cleanup. No existing pilot repair was attempted.`,
    );
}
