import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
  windowsSecretStore,
  localMcpbAdapter,
  definitionHash,
  createManagedPeerFactory,
} from '@waleed/hub-core';
import { bundleManifest, zip } from '../helpers/mcpb.js';
import { memoryStore } from '../helpers/memory-store.js';
import { apply } from '../helpers/runtime.js';

it.skipIf(process.platform !== 'win32')(
  'production meta-tools lease real DPAPI credentials and reap the contained bundle process tree',
  async () => {
    const directory = await mkdtemp(
        'E:\\Dev\\Temp\\opencode\\tool-search-dpapi-',
      ),
      vault = await windowsSecretStore(join(directory, 'credentials')),
      store = memoryStore(),
      hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
        secrets: { windows: vault },
        bundles: await localMcpbAdapter(directory),
        playgroundConnect: createManagedPeerFactory(directory, () =>
          store.read(),
        ),
        requestLogDirectory: directory,
      });
    const agent = new Client(
        { name: 'synthetic-search-dpapi-agent', version: '1' },
        { capabilities: {} },
      ),
      secret = 'SYNTHETIC-REAL-SEARCH-CREDENTIAL-0123456789',
      pidPath = join(directory, 'public-pids.json');
    try {
      const manifest = bundleManifest();
      manifest.server.mcp_config.env = { TOKEN: '${user_config.token}' };
      const script = `import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{},windowsHide:true});child.unref();
let calls=0;const save=()=>writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({root:process.pid,child:child.pid,calls}));save();
const valid=createHash('sha256').update(process.env.TOKEN??'').digest('hex')===${JSON.stringify(createHash('sha256').update(secret).digest('hex'))};
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'synthetic-protected-bundle',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'read',description:'Read protected fixture',inputSchema:{type:'object'},_meta:{keywords:['protected']}}]};
else if(m.method==='tools/call'){calls++;save();result={content:[{type:'text',text:m.params.arguments?.echo?process.env.TOKEN:valid?'protected contained success':'credential missing'}]};}
else if(m.method==='resources/list')result={resources:[{uri:'fixture://protected',name:'protected'}]};
else if(m.method==='resources/templates/list')result={resourceTemplates:[{uriTemplate:'fixture://protected/{key}',name:'protected template'}]};
else if(m.method==='resources/read')result={contents:[{uri:m.params.uri,text:m.params.uri.endsWith('/echo')?process.env.TOKEN:valid?'protected contained resource success':'credential missing'}]};
else if(m.method==='prompts/list')result={prompts:[{name:'protected_prompt',arguments:[{name:'topic'}]}]};
else if(m.method==='prompts/get')result={messages:[{role:'user',content:{type:'text',text:m.params.arguments?.echo==='true'?process.env.TOKEN:valid?'protected contained prompt success':'credential missing'}}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
      const preview = hub.bundles.preview(
          zip([
            { name: 'manifest.json', data: JSON.stringify(manifest) },
            { name: 'server/index.mjs', data: script },
          ]),
          'owner',
        ),
        receipt = await hub.bundles.install(
          preview.id,
          {
            expectedRevision: 0,
            configuration: { token: secret },
            confirmInstall: true,
          },
          'owner',
        );
      const saved = (await hub.inventory()).connectors[0]!;
      expect(
        (
          await apply(hub, {
            kind: 'approve_connector',
            connectorId: saved.id,
            expectedConnectorRevision: saved.revision,
            definitionHash: definitionHash(saved),
            approveExecution: true,
          })
        ).state,
      ).toBe('succeeded');
      await apply(hub, {
        kind: 'set_agent_tool_search',
        agentId: 'cursor',
        toolSearchMode: true,
      });
      await apply(hub, {
        kind: 'set_tool_override',
        connectorId: saved.id,
        expectedConnectorRevision: saved.revision,
        originalToolName: 'read',
        override: {
          connectorId: saved.id,
          originalToolName: 'read',
          alias: 'inspect_protected',
          customDescription: 'Inspect the protected contained fixture.',
          annotations: { readOnlyHint: true },
        },
      });
      const state = await hub.inventory();
      state.integrations = [
        {
          agentId: 'cursor',
          configPath: 'C:\\Synthetic\\cursor.json',
          entryHash: '0'.repeat(64),
          syncedRevision: state.revision,
          updatedAt: new Date().toISOString(),
        },
      ];
      await writeFile(join(directory, 'state.json'), JSON.stringify(state));
      await store.write(state.revision, state);
      await expect
        .poll(() => hub.requestLogSnapshot().agentLogChannel)
        .toBe('available');
      await writeFile(
        join(directory, 'safety.json'),
        JSON.stringify(await hub.safety.read()),
      );
      await agent.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            '--import',
            'tsx',
            fileURLToPath(
              new URL(
                '../../packages/hub-core/src/integrations/bridge.ts',
                import.meta.url,
              ),
            ),
            join(directory, 'state.json'),
            'cursor',
          ],
          stderr: 'pipe',
        }),
        { timeout: 20_000 },
      );
      expect((await agent.listTools()).tools.map((tool) => tool.name)).toEqual([
        'search_tools',
        'call_tool',
      ]);
      await expect(readFile(pidPath)).rejects.toHaveProperty('code', 'ENOENT');
      const result = await agent.callTool({
          name: 'search_tools',
          arguments: { query: 'protected' },
        }),
        tools = (result.structuredContent as { tools: Array<{ name: string }> })
          .tools;
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('inspect_protected');
      const before = JSON.parse(await readFile(pidPath, 'utf8')) as {
        root: number;
        child: number;
        calls: number;
      };
      expect(before.calls).toBe(0);
      for (const pid of [before.root, before.child])
        expect(() => process.kill(pid, 0)).not.toThrow();
      expect(
        await agent.callTool({
          name: 'call_tool',
          arguments: { name: tools[0]!.name, arguments: {} },
        }),
      ).toMatchObject({ content: [{ text: 'protected contained success' }] });
      expect(JSON.parse(await readFile(pidPath, 'utf8')).calls).toBe(1);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(receipt.requiresApproval).toBe(true);
      const resources = await agent.listResources(),
        prompts = await agent.listPrompts();
      expect(resources.resources).toHaveLength(1);
      expect(prompts.prompts).toHaveLength(1);
      expect(
        (await agent.readResource({ uri: resources.resources[0]!.uri }))
          .contents[0],
      ).toMatchObject({
        uri: resources.resources[0]!.uri,
        text: 'protected contained resource success',
      });
      expect(
        (
          await agent.getPrompt({
            name: prompts.prompts[0]!.name,
            arguments: { topic: 'SYNTHETIC-PRIVATE-PROMPT' },
          })
        ).messages[0]!.content,
      ).toMatchObject({
        type: 'text',
        text: 'protected contained prompt success',
      });
      const templates = await agent.listResourceTemplates(),
        echoUri = templates.resourceTemplates[0]!.uriTemplate.replace(
          '{?key}',
          '?key=echo',
        );
      await expect(agent.readResource({ uri: echoUri })).rejects.not.toThrow(
        secret,
      );
      await expect(
        agent.getPrompt({
          name: prompts.prompts[0]!.name,
          arguments: { echo: 'true' },
        }),
      ).rejects.not.toThrow(secret);
      await expect
        .poll(
          () =>
            hub.requestLog
              .records()
              .filter((record) => record.agentId === 'cursor').length,
        )
        .toBe(2);
      expect(
        hub.requestLog.records().find((record) => record.toolName === 'read'),
      ).toMatchObject({
        agentId: 'cursor',
        connectorId: saved.id,
        status: 'success',
      });
      async function scan(path: string) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const target = join(path, entry.name);
          if (entry.isDirectory()) await scan(target);
          else {
            const bytes = await readFile(target);
            try {
              expect(bytes.includes(Buffer.from(secret))).toBe(false);
              expect(bytes.includes(Buffer.from(secret, 'utf16le'))).toBe(
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
      await agent.close();
      for (const pid of [before.root, before.child])
        expect(() => process.kill(pid, 0)).toThrow();
      const catalog = await hub.playground.catalog({ connectorId: saved.id });
      const job = hub.playground.invoke(
        {
          connectorId: saved.id,
          toolName: 'read',
          arguments: { value: 'SYNTHETIC-PLAYGROUND-PRIVATE' },
          confirmExecute: true,
          expectedRevision: catalog.revision,
          expectedToolSchemaHash: catalog.tools[0]!.schemaHash,
        },
        'owner',
      );
      await hub.playground.drain();
      expect(hub.playground.job(job.id, 'owner')).toMatchObject({
        state: 'succeeded',
        result: {
          output: expect.stringContaining('protected contained success'),
        },
      });
      const last = JSON.parse(await readFile(pidPath, 'utf8'));
      for (const pid of [last.root, last.child])
        expect(() => process.kill(pid, 0)).toThrow();
      const echo = hub.playground.invoke(
        {
          connectorId: saved.id,
          toolName: 'read',
          arguments: { echo: true },
          confirmExecute: true,
        },
        'owner',
      );
      await hub.playground.drain();
      expect(hub.playground.job(echo.id, 'owner').state).toBe('failed');
      expect(
        hub.requestLog
          .records()
          .filter((record) => record.agentId === 'hub_playground'),
      ).toHaveLength(2);
      expect(
        JSON.stringify([
          hub.requestLog.records(),
          hub.playground.job(echo.id, 'owner'),
        ]),
      ).not.toContain(secret);
      expect(JSON.stringify(hub.requestLog.records())).not.toContain(
        'SYNTHETIC-PLAYGROUND-PRIVATE',
      );
      await scan(directory);
    } finally {
      await agent.close();
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
