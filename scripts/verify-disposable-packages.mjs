// Opt-in network smoke. Only these reviewed exact packages are installed into a
// fresh private runtime; no real agent config, credentials or global install changes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConnectorSchema } from '@waleed/contracts';
import { definitionHash, emptyState, emptySafetyState } from '@waleed/hub-core';
import { localPackageRuntime } from '../packages/hub-core/dist/adapters/packages.js';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error('Build and use Node 24 on Windows.');
const directory = await mkdtemp(join(tmpdir(), 'hub-package-smoke-'));
const client = new Client(
  { name: 'disposable-package-agent', version: '1' },
  { capabilities: {} },
);
let clean = false,
  stage = 'initialization';
try {
  const runtime = await localPackageRuntime(directory),
    state = emptyState(),
    time = new Date().toISOString();
  for (const spec of [
    {
      manager: 'npm',
      name: '@modelcontextprotocol/server-memory',
      version: '2.0.1',
      entryPoint: 'mcp-server-memory',
    },
    {
      manager: 'uvx',
      name: 'mcp-server-time',
      version: '2026.10.28',
      entryPoint: 'mcp-server-time',
    },
  ]) {
    stage = `${spec.manager}_prepare`;
    const connector = ConnectorSchema.parse({
      id: spec.manager,
      name: spec.manager === 'npm' ? 'npm-memory' : 'python-time',
      description: 'Disposable package verification',
      enabled: true,
      revision: 1,
      createdAt: time,
      updatedAt: time,
      executionMode: 'package',
      transport: 'stdio',
      package: spec,
      arguments: [],
      environmentLiterals: {},
      secretBindings: {},
      headerBindings: {},
      trustApproval: null,
    });
    connector.trustApproval = {
      revision: 1,
      approvedAt: time,
      risk: 'native_execution',
      definitionHash: definitionHash(connector),
    };
    await runtime.prepare(connector, AbortSignal.timeout(120_000), true);
    await runtime.prepare(connector, AbortSignal.timeout(20_000));
    state.connectors.push(connector);
  }
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
  await writeFile(registry, JSON.stringify(state));
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
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  stage = 'bridge_initialize';
  await client.connect(transport, { timeout: 20_000 });
  stage = 'bridge_discovery';
  const list = await client.listTools({}, { timeout: 55_000 });
  for (const [name, args] of [
    ['npm-memory__read_graph', {}],
    ['python-time__get_current_time', { timezone: 'UTC' }],
  ]) {
    stage = name;
    assert(
      list.tools.some((tool) => tool.name === name),
      'Prepared package tool is missing.',
    );
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 60_000 },
      );
      assert(!result.isError, 'Prepared package tool returned an error.');
    }
  }
  stage = 'teardown';
  await client.close();
  for (const connector of state.connectors)
    await runtime.prepare(connector, AbortSignal.timeout(20_000));
  clean = true;
  console.info(
    JSON.stringify(
      {
        packages: 'pinned_npm_and_uvx_installed_privately',
        bridge: 'both_packages_discovered_and_called_twice',
        globalInstalls: 0,
        personalCredentialsUsed: 0,
      },
      null,
      2,
    ),
  );
} catch {
  process.exitCode = 1;
  console.error(
    `Disposable package verification failed at ${stage}; raw installer/provider diagnostics are suppressed.`,
  );
} finally {
  await client.close().catch(() => undefined);
  if (clean)
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  else console.error(`Inspect only the owned disposable runtime: ${directory}`);
}
