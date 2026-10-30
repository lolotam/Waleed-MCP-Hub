import { tmpdir } from 'node:os';
// Compiled CurrentUser vault + generated native launcher smoke, entirely
// disposable. No Docker/provider/agent config or real credential is involved.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  windowsSecretStore,
  openStateStore,
  openSafetyLedger,
  createLifecycle,
  createMaterializer,
  managedFiles,
  createCapabilityRuntime,
  createBindingResolver,
  definitionHash,
} from '@waleed/hub-core';

if (process.platform !== 'win32') throw new Error('Use Windows.');
if (!process.versions.node.startsWith('24.')) {
  const { existsSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const candidate = [
    join(process.cwd(), 'runtime', 'node.exe'),
    'E:\\Dev\\Tools_and_Utilities\\nodejs24\\node.exe',
  ].find((p) => existsSync(p));
  if (candidate) {
    const res = spawnSync(
      candidate,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit' },
    );
    process.exit(res.status ?? 0);
  }
  throw new Error('Use Node 24 on Windows.');
}
const directory = await mkdtemp(join(tmpdir(), 'hub-p6-compiled-'));
const store = await openStateStore(directory),
  safety = await openSafetyLedger(directory),
  backend = await windowsSecretStore(join(directory, 'credentials'));
const files = managedFiles({
  runtime: join(directory, 'managed'),
  catalog: join(directory, 'catalog'),
});
const hub = createLifecycle(store, Date.now, safety, {
  secrets: { windows: backend },
  runtime: createCapabilityRuntime({
    workingDirectory: directory,
    resolveBindings: createBindingResolver({ windows: backend }, () =>
      store.read(),
    ),
  }),
  materializer: createMaterializer({
    files,
    nodeExecutable: process.execPath,
    registryPath: join(directory, 'state.json'),
    launcherModuleUrl: new URL(
      '../packages/hub-core/dist/runtime/launcher.js',
      import.meta.url,
    ).href,
  }),
});
async function apply(operation) {
  const preview = await hub.preview(
    { expectedRevision: (await hub.inventory()).revision, ...operation },
    'smoke',
  );
  const job = await hub.apply(preview.id, 'smoke');
  await hub.drain();
  const result = hub.job(job.id, 'smoke');
  assert.equal(result.state, 'succeeded');
  return result.resultId;
}
let success = false;
try {
  await apply({
    kind: 'create_connector',
    definition: {
      id: 'native',
      name: 'Synthetic protected native',
      description: '',
      enabled: true,
      environmentLiterals: {},
      secretBindings: {},
      headerBindings: {},
      trustApproval: null,
      executionMode: 'native',
      transport: 'stdio',
      executable: process.execPath,
      arguments: [
        fileURLToPath(
          new URL('../tests/fixtures/mcp-secret.mjs', import.meta.url),
        ),
        join(directory, 'evidence.json'),
      ],
    },
  });
  const receipt = await hub.auth.credentials.write('native', {
    expectedRevision: 1,
    expectedConnectorRevision: 1,
    location: 'environment',
    name: 'PROVIDER_TOKEN',
    format: 'raw',
    adapter: 'windows',
    value: 'SYNTHETIC_NATIVE_DPAPI_0123456789',
  });
  const connector = (await hub.inventory()).connectors[0];
  await apply({
    kind: 'approve_connector',
    connectorId: 'native',
    expectedConnectorRevision: connector.revision,
    definitionHash: definitionHash(connector),
    approveExecution: true,
  });
  const check = await hub.checks.start('native', 'smoke');
  await hub.checks.drain();
  assert.equal(hub.checks.job(check.id, 'smoke').state, 'succeeded');
  const profileId = await apply({
    kind: 'create_profile',
    name: 'Disposable protected native',
    description: '',
    connectorIds: ['native'],
  });
  await apply({ kind: 'materialize_profile', profileId });
  const record = (await hub.inventory()).materializations[0];
  const entry = record.files.find((file) => file.name.endsWith('.mjs'));
  assert(entry);
  const client = new Client(
    { name: 'synthetic-protected-agent', version: '1' },
    { capabilities: {} },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [files.path('runtime', entry.name)],
        env: { UNRELATED_PROVIDER_TOKEN: 'SYNTHETIC-not-for-target' },
        stderr: 'pipe',
      }),
      { timeout: 15_000 },
    );
    assert.equal(
      (await client.listTools()).tools[0].name,
      'fixture_secret_read',
    );
  } finally {
    await client.close();
  }
  const evidence = JSON.parse(
    await readFile(join(directory, 'evidence.json'), 'utf8'),
  );
  assert.equal(evidence.accepted, true);
  assert(!evidence.methods.includes('tools/call'));
  const registry = await readFile(join(directory, 'state.json'), 'utf8');
  assert(!registry.includes('SYNTHETIC_NATIVE_DPAPI_0123456789'));
  const ciphertext = await readFile(
    join(directory, 'credentials', `${receipt.id}.dpapi`),
  );
  assert(
    !ciphertext.includes(Buffer.from('SYNTHETIC_NATIVE_DPAPI_0123456789')),
  );
  await apply({ kind: 'dematerialize_profile', profileId });
  await apply({ kind: 'remove_profile', profileId });
  await apply({ kind: 'remove_connector', connectorId: 'native' });
  await hub.auth.credentials.delete(
    receipt.id,
    (await hub.inventory()).revision,
  );
  assert.equal(await backend.has(receipt.id, AbortSignal.timeout(1000)), false);
  success = true;
  console.info(
    'Compiled DPAPI, authenticated MCP discovery, reference-only native launcher and owned cleanup passed (zero tools/call).',
  );
} finally {
  await hub.close();
  await safety.close();
  await store.close();
  if (success)
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  else
    console.error(
      `Only disposable recovery state retained at ${directory}; no existing pilot or agent was changed.`,
    );
}
