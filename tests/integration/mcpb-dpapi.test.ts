import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsSecretStore,
  localMcpbAdapter,
  createBindingResolver,
  createCapabilityRuntime,
  createAgentBridge,
  createWindowsProcessRunner,
  definitionHash,
} from '@waleed/hub-core';
import { ContainedStdioTransport } from '../../packages/hub-core/src/adapters/mcp/stdio.js';
import { memoryStore } from '../helpers/memory-store.js';
import { bundleManifest, zip } from '../helpers/mcpb.js';

it.skipIf(process.platform !== 'win32')(
  'installs with real DPAPI, contains the approved runtime and reuses a persistent bundle session',
  async () => {
    const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\mcpb-dpapi-'),
      vault = await windowsSecretStore(join(directory, 'credentials')),
      adapter = await localMcpbAdapter(directory),
      store = memoryStore(),
      safety = createMemorySafetyLedger();
    const bindings = createBindingResolver({ windows: vault }, () =>
        store.read(),
      ),
      runtime = createCapabilityRuntime({
        workingDirectory: directory,
        prepareBundle: (connector) => adapter.prepare(connector),
        resolveBindings: bindings,
      });
    const hub = createLifecycle(store, Date.now, safety, {
      secrets: { windows: vault },
      bundles: adapter,
      runtime,
    });
    let starts = 0,
      bridge: ReturnType<typeof createAgentBridge> | undefined,
      agent: Client | undefined;
    const secret = 'SYNTHETIC-REAL-MCPB-DPAPI-0123456789';
    try {
      const manifest = bundleManifest();
      manifest.server.mcp_config.env = { TOKEN: '${user_config.token}' };
      // Builtins only; no installs, package import hooks or network dependencies.
      const script = `import {createInterface} from 'node:readline';
let calls=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-bundle',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'read',inputSchema:{type:'object'}}]};
else if(m.method==='tools/call')result={content:[{type:'text',text:String(++calls)}]};
else if(m.method==='resources/list')result={resources:[]};else if(m.method==='prompts/list')result={prompts:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
      const preview = hub.bundles.preview(
        zip([
          { name: 'manifest.json', data: JSON.stringify(manifest) },
          { name: 'server/index.mjs', data: script },
        ]),
        'owner',
      );
      const receipt = await hub.bundles.install(
        preview.id,
        {
          expectedRevision: 0,
          configuration: { token: secret },
          confirmInstall: true,
        },
        'owner',
      );
      const state = await store.read(),
        connector = state.connectors[0]!;
      if (connector.executionMode !== 'native') throw new Error();
      // Execution remains denied until the ordinary approval path is used.
      await expect(
        hub.checks.start(connector.id, 'owner'),
      ).rejects.toHaveProperty('code', 'conflict');
      const approval = await hub.preview(
        {
          kind: 'approve_connector',
          expectedRevision: state.revision,
          connectorId: connector.id,
          expectedConnectorRevision: connector.revision,
          definitionHash: definitionHash(connector),
          approveExecution: true,
        },
        'owner',
      );
      const job = await hub.apply(approval.id, 'owner');
      await hub.drain();
      expect(hub.job(job.id, 'owner').state).toBe('succeeded');
      connector.trustApproval = (
        await store.read()
      ).connectors[0]!.trustApproval;
      const lease = await bindings(connector, new AbortController().signal);
      try {
        expect(lease.environment.TOKEN).toBe(secret);
      } finally {
        lease.dispose();
      }
      await writeFile(
        join(directory, 'public-state.json'),
        JSON.stringify(await store.read()),
      );
      async function scan(path: string) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const target = join(path, entry.name);
          if (entry.isDirectory()) await scan(target);
          else {
            const bytes = await readFile(target);
            try {
              for (const encoding of ['utf8', 'utf16le'] as const)
                expect(bytes.includes(Buffer.from(secret, encoding))).toBe(
                  false,
                );
              expect(
                bytes.includes(
                  Buffer.from(Buffer.from(secret).toString('base64')),
                ),
              ).toBe(false);
            } finally {
              bytes.fill(0);
            }
          }
        }
      }
      await scan(directory);
      const result = await runtime.discover(
        connector,
        AbortSignal.timeout(20_000),
      );
      expect(result.tools[0]?.name).toBe('read');
      bridge = createAgentBridge(
        () => store.read(),
        async (item, signal) => {
          if (item.executionMode !== 'native') throw new Error();
          const launch = await adapter.prepare(item),
            lease = await bindings(item, signal);
          starts++;
          const runner = await createWindowsProcessRunner({
              workingDirectory: launch.workingDirectory,
              allowedExecutables: [launch.executable],
              concurrency: 1,
            }),
            client = new Client(
              { name: 'bundle-test-peer', version: '1' },
              { capabilities: {} },
            );
          const transport = new ContainedStdioTransport(
            runner,
            {
              executable: launch.executable,
              arguments: launch.arguments,
              environment: lease.environment,
              timeoutMs: 3_600_000,
              session: true,
              outputLimitBytes: 1024 * 1024,
            },
            signal,
          );
          await client.connect(transport);
          return {
            client,
            assertPublic() {},
            async dispose() {
              try {
                await client.close();
                await transport.close();
              } finally {
                lease.dispose();
              }
            },
          };
        },
      );
      const [a, b] = InMemoryTransport.createLinkedPair();
      await bridge.connect(a);
      agent = new Client(
        { name: 'bundle-test-agent', version: '1' },
        { capabilities: {} },
      );
      await agent.connect(b);
      const catalog = await agent.listTools();
      expect(catalog.tools).toHaveLength(1);
      const tool = catalog.tools[0]!.name;
      expect(receipt.connectorId).toBe(connector.id);
      expect(await agent.callTool({ name: tool })).toMatchObject({
        content: [{ text: '1' }],
      });
      expect(await agent.callTool({ name: tool })).toMatchObject({
        content: [{ text: '2' }],
      });
      expect(starts).toBe(1);
      await agent.close();
      await bridge.close();
      // Direct materialized native launchers must not bypass bundle validation.
      const diskState = await store.read();
      diskState.profiles.push({
        id: 'profile',
        name: 'Synthetic',
        description: '',
        connectorIds: [connector.id],
        revision: 1,
        dockerProfileId: null,
        updatedAt: new Date().toISOString(),
      });
      const registryPath = join(directory, 'state.json');
      await writeFile(registryPath, JSON.stringify(diskState));
      await writeFile(
        join(directory, 'safety.json'),
        JSON.stringify(await safety.read()),
      );
      const launchManifest = JSON.stringify({
          version: 1,
          registryPath,
          profileId: 'profile',
          connector,
        }),
        launchPath = join(directory, 'launch.json');
      await writeFile(launchPath, launchManifest);
      const launch = () =>
        new StdioClientTransport({
          command: process.execPath,
          args: [
            '--import',
            'tsx',
            fileURLToPath(
              new URL('../fixtures/mcpb-launcher.mjs', import.meta.url),
            ),
            launchPath,
            createHash('sha256').update(launchManifest).digest('hex'),
          ],
          stderr: 'pipe',
        });
      const direct = new Client(
        { name: 'direct-bundle-agent', version: '1' },
        { capabilities: {} },
      );
      try {
        await direct.connect(launch(), { timeout: 15_000 });
        expect((await direct.listTools()).tools[0]?.name).toBe('read');
      } finally {
        await direct.close();
      }
      await writeFile(
        join(adapter.path(connector.bundle!.id), 'server', 'index.mjs'),
        'throw new Error("tampered code must not execute");',
      );
      const refused = new Client(
        { name: 'tampered-bundle-agent', version: '1' },
        { capabilities: {} },
      );
      try {
        await expect(
          refused.connect(launch(), { timeout: 5000 }),
        ).rejects.toThrow();
      } finally {
        await refused.close();
      }
      await scan(directory);
    } finally {
      await agent?.close();
      await bridge?.close();
      await hub.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
  90_000,
);
