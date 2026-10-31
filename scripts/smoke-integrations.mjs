import { tmpdir } from 'node:os';
// Real protected Windows files/DPAPI/compiled bridge, exclusively disposable roots.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  openStateStore,
  openSafetyLedger,
  createLifecycle,
  localRuntimeAdapters,
  windowsAgentTargets,
  definitionHash,
  writeBootRecord,
} from '@waleed/hub-core';
if (process.platform !== 'win32')
  throw new Error('Windows integration smoke requires Windows.');
const directory = await mkdtemp(join(tmpdir(), 'hub-p7-compiled-')),
  home = join(directory, 'home'),
  runtime = join(directory, 'runtime');
await mkdir(home);
await mkdir(runtime);
const environment = {
  USERPROFILE: home,
  APPDATA: join(home, 'Roaming'),
  PATH: '',
};
const targets = windowsAgentTargets(home, environment);
for (const target of targets) {
  await mkdir(dirname(target.paths[0]), { recursive: true });
  await writeFile(
    target.paths[0],
    target.format === 'codex'
      ? '# preserve this\n[tools]\nnode_repl=true\n'
      : '{\n// preserve this\n"unrelated":"SYNTHETIC-existing-private"\n}\n',
  );
}
const store = await openStateStore(runtime),
  safety = await openSafetyLedger(runtime);
// The compiled bridge fails closed without a boot record: it names the hub
// generation it belongs to.
await writeBootRecord(runtime);
const hub = createLifecycle(
  store,
  Date.now,
  safety,
  await localRuntimeAdapters(runtime, environment, () => store.read()),
);
const apply = async (operation) => {
  const preview = await hub.preview(
    { expectedRevision: (await store.read()).revision, ...operation },
    'smoke',
  );
  const job = await hub.apply(preview.id, 'smoke');
  await hub.drain();
  assert.equal(hub.job(job.id, 'smoke').state, 'succeeded');
};
let success = false;
try {
  await apply({
    kind: 'create_connector',
    definition: {
      id: 'synthetic',
      name: 'Synthetic protected agent peer',
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
          new URL('../tests/fixtures/agent-peer.mjs', import.meta.url),
        ),
        join(directory, 'evidence.json'),
      ],
    },
  });
  await hub.auth.credentials.write('synthetic', {
    expectedRevision: (await store.read()).revision,
    expectedConnectorRevision: 1,
    location: 'environment',
    name: 'PROVIDER_TOKEN',
    format: 'raw',
    adapter: 'windows',
    value: 'SYNTHETIC_AGENT_DPAPI_TOKEN',
  });
  const connector = (await store.read()).connectors[0];
  await apply({
    kind: 'approve_connector',
    connectorId: connector.id,
    expectedConnectorRevision: connector.revision,
    definitionHash: definitionHash(connector),
    approveExecution: true,
  });
  const scanned = await hub.integrations.scan();
  assert.equal(scanned.agents.length, 9);
  for (const agent of scanned.agents) {
    assert.equal(agent.status, 'not_integrated');
    const receipt = await hub.integrations.integrate(agent.agentId, {
      expectedRevision: (await store.read()).revision,
      fingerprint: agent.fingerprint,
      confirmConfigurationChange: true,
    });
    assert.equal(receipt.agent.status, 'integrated');
    assert(receipt.backup.endsWith('.bak'));
  }
  const cursor = targets.find((target) => target.id === 'cursor');
  const text = await readFile(cursor.paths[0], 'utf8');
  assert(text.includes('preserve this'));
  assert(!text.includes('SYNTHETIC_AGENT_DPAPI_TOKEN'));
  const raw = JSON.parse(text.replace(/\/\/[^\n]*/g, ''));
  const entry = raw.mcpServers['waleed-mcp-hub'];
  const agent = new Client(
    { name: 'synthetic-independent-agent', version: '1' },
    { capabilities: {} },
  );
  try {
    await agent.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: { UNRELATED_PROVIDER_TOKEN: 'SYNTHETIC-not-for-peer' },
        stderr: 'pipe',
      }),
      { timeout: 20000 },
    );
    const tools = await agent.listTools();
    assert.equal(tools.tools.length, 1);
    let evidence = JSON.parse(
      await readFile(join(directory, 'evidence.json'), 'utf8'),
    );
    assert.equal(evidence.accepted, true);
    assert(!evidence.methods.includes('tools/call'));
    const result = await agent.callTool({
      name: tools.tools[0].name,
      arguments: {},
    });
    assert.equal(
      result.content[0].text,
      'Synthetic explicit tool call succeeded.',
    );
    evidence = JSON.parse(
      await readFile(join(directory, 'evidence.json'), 'utf8'),
    );
    assert(evidence.methods.includes('tools/call'));
    // A second native connector keeps its process between the calls: the
    // counter answers 1, 2 and 3 over one connection.
    await apply({
      kind: 'create_connector',
      definition: {
        id: 'counter',
        name: 'Counter',
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
            new URL('../tests/fixtures/counter-peer.mjs', import.meta.url),
          ),
        ],
      },
    });
    const counter = (await store.read()).connectors.find(
      (item) => item.id === 'counter',
    );
    await apply({
      kind: 'approve_connector',
      connectorId: 'counter',
      expectedConnectorRevision: counter.revision,
      definitionHash: definitionHash(counter),
      approveExecution: true,
    });
    const listed = await agent.listTools();
    assert.equal(listed.tools.length, 2);
    const increment = listed.tools.find(
      (tool) => tool.name === 'counter__increment',
    );
    assert(increment);
    for (const expected of ['1', '2', '3']) {
      const counted = await agent.callTool({
        name: increment.name,
        arguments: {},
      });
      assert.equal(counted.content[0].text, expected);
    }
    await apply({
      kind: 'set_connector_enabled',
      connectorId: 'synthetic',
      enabled: false,
    });
    assert.equal(
      (await agent.callTool({ name: tools.tools[0].name, arguments: {} }))
        .isError,
      true,
    );
  } finally {
    await agent.close();
  }
  for (const target of targets) {
    const agent = await hub.integrations.status(target.id);
    const receipt = await hub.integrations.disconnect(target.id, {
      expectedRevision: (await store.read()).revision,
      fingerprint: agent.fingerprint,
      confirmConfigurationChange: true,
    });
    assert.equal(receipt.agent.status, 'not_integrated');
    assert((await readFile(target.paths[0], 'utf8')).includes('preserve this'));
  }
  success = true;
  console.info(
    'Compiled nine-scope private backup/integrate/disconnect and DPAPI-backed independent bridge passed. Discovery invoked no tools; one explicit synthetic call succeeded; a pooled native connector answered 1, 2 and 3 over one persistent process; disabled routing was rejected. No real agent/pilot was changed.',
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
      `Only disposable recovery evidence retained at ${directory}.`,
    );
}
