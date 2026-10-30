// Opt-in real gateway smoke: an already-cached Node image, a fresh synthetic
// secret and isolated registry. Never reads personal connector/account settings.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StateSchema } from '@waleed/contracts';
import {
  createWindowsDiscoveryPorts,
  createWindowsProcessRunner,
  definitionHash,
  dockerCommand,
  dockerSecretStore,
  emptySafetyState,
  emptyState,
} from '@waleed/hub-core';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error('Use Node 24 on Windows after building.');
const directory = await mkdtemp(join(tmpdir(), 'hub-docker-bridge-smoke-'));
const id = `wmh-secret-${randomUUID()}`;
const value = Buffer.from(`SYNTHETIC DISPOSABLE ${randomUUID()}`);
const client = new Client(
  { name: 'disposable-agent', version: '1' },
  { capabilities: {} },
);
let backend,
  attempted = false,
  clean = false;
let stage = 'docker_preflight';
try {
  const [executable] = await createWindowsDiscoveryPorts({
    workingDirectory: directory,
    environment: process.env,
  }).find(['docker'], AbortSignal.timeout(3000));
  assert(executable?.toLowerCase().endsWith('.exe'));
  const runner = await createWindowsProcessRunner({
    allowedExecutables: [executable],
    workingDirectory: directory,
  });
  const docker = dockerCommand(runner, executable, process.env);
  // Pin the cached image ID. Fail rather than pulling/installing an image.
  const image = (
    await docker.run(
      ['image', 'inspect', '--format', '{{.Id}}', 'node:24-bookworm-slim'],
      AbortSignal.timeout(20_000),
    )
  ).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  backend = dockerSecretStore(docker, runner);
  assert.equal(await backend.has(id, AbortSignal.timeout(15_000)), false);
  attempted = true;
  stage = 'synthetic_secret_write';
  await backend.put(id, value, AbortSignal.timeout(30_000));

  const digest = createHash('sha256').update(value).digest('hex');
  const source = `
    const readline = require('node:readline');
    const crypto = require('node:crypto');
    const accepted = crypto.createHash('sha256').update(process.env.PROVIDER_TOKEN || '').digest('hex') === '${digest}';
    let calls = 0;
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      let result;
      if (m.method === 'initialize') result = {
        protocolVersion: m.params.protocolVersion, capabilities: {tools:{}},
        serverInfo:{name:'synthetic-secret-peer',version:'1'}
      };
      else if (m.method === 'tools/list') result = {
        tools:[{name:'verify',description:'Synthetic credential check',inputSchema:{type:'object'}}]
      };
      else if (m.method === 'tools/call') result = {
        content:[{type:'text',text:accepted ? 'synthetic credential accepted '+(++calls) : 'synthetic credential missing'}]
      };
      else result = {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `;
  const encoded = Buffer.from(source).toString('base64');
  const state = emptyState();
  const time = new Date().toISOString();
  const connector = {
    id: 'synthetic-docker',
    name: 'Synthetic Docker bridge',
    description: 'Disposable real gateway smoke',
    enabled: true,
    revision: 1,
    createdAt: time,
    updatedAt: time,
    executionMode: 'docker',
    transport: 'stdio',
    image,
    command: ['node'],
    arguments: ['-e', `eval(Buffer.from('${encoded}','base64').toString())`],
    secretBindings: { PROVIDER_TOKEN: id },
    headerBindings: {},
    environmentLiterals: {},
    trustApproval: null,
  };
  connector.trustApproval = {
    revision: 1,
    approvedAt: time,
    definitionHash: definitionHash(connector),
    risk: 'image_execution',
  };
  state.connectors.push(connector);
  state.secretReferences.push({
    id,
    adapter: 'docker',
    present: true,
    ownerIds: [connector.id],
    kind: 'credential',
  });
  state.integrations = [
    {
      agentId: 'opencode',
      configPath: join(directory, 'synthetic-agent.json'),
      entryHash: 'a'.repeat(64),
      syncedRevision: 0,
      updatedAt: time,
    },
  ];
  const registry = join(directory, 'state.json');
  stage = 'isolated_registry';
  await writeFile(registry, JSON.stringify(StateSchema.parse(state)));
  await writeFile(
    join(directory, 'safety.json'),
    JSON.stringify(emptySafetyState()),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          '../packages/hub-core/dist/integrations/bridge.js',
          import.meta.url,
        ),
      ),
      registry,
      'opencode',
    ],
    // SDK defaults omit ProgramData; Docker's Windows plugin needs the reviewed
    // OS allowlist, not API credentials or the caller's unrestricted environment.
    env: docker.environment,
    stderr: 'pipe',
  });
  stage = 'bridge_initialize';
  await client.connect(transport, { timeout: 20_000 });
  transport.stderr?.resume();
  stage = 'bridge_tools_list';
  const tools = await client.listTools({}, { timeout: 55_000 });
  assert.equal(
    tools.tools.length,
    1,
    'The synthetic Docker-secret peer must expose one tool.',
  );
  stage = 'bridge_tool_call';
  const result = await client.callTool(
    { name: tools.tools[0].name, arguments: {} },
    undefined,
    { timeout: 60_000 },
  );
  assert.deepEqual(result.content, [
    { type: 'text', text: 'synthetic credential accepted 1' },
  ]);
  const second = await client.callTool(
    { name: tools.tools[0].name, arguments: {} },
    undefined,
    { timeout: 60_000 },
  );
  assert.deepEqual(second.content, [
    { type: 'text', text: 'synthetic credential accepted 2' },
  ]);
  stage = 'owned_cleanup';
  await client.close();
  assert.deepEqual(
    await readdir(join(directory, 'owned-agent-containers')),
    [],
  );
  clean = true;
  console.info(
    JSON.stringify(
      {
        gateway: 'real_initialize_list_and_explicit_call_passed',
        syntheticCredential: 'accepted_in_container',
        persistentSession: 'state_retained_between_two_calls',
        ownedArtifacts: 'cleaned',
        personalConnectorsModified: 0,
        existingSecretsModified: 0,
        imagePulls: 0,
      },
      null,
      2,
    ),
  );
} catch {
  process.exitCode = 1;
  console.error(
    `Disposable Docker bridge verification failed at ${stage}; no raw provider diagnostics are printed.`,
  );
} finally {
  await client.close().catch(() => undefined);
  value.fill(0);
  let secretClean = !attempted;
  if (attempted) {
    try {
      await backend.delete(id, AbortSignal.timeout(20_000));
      secretClean = !(await backend.has(id, AbortSignal.timeout(15_000)));
    } catch {
      /* Retain only this disposable runtime as recovery evidence. */
    }
  }
  if (clean && secretClean)
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  else {
    process.exitCode = 1;
    console.error(
      `Inspect disposable runtime ${directory} and owned secret ${id}; no existing secret was modified.`,
    );
  }
}
