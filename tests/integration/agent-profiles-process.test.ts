import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { agentProfilesFixture } from '../helpers/agent-profiles.js';
import { apply } from '../helpers/runtime.js';

it('production argv-target bridges isolate agents and notify on an atomic registry profile change', async () => {
  const fixture = await agentProfilesFixture({
      agentIds: ['cursor', 'codex', 'goose'],
    }),
    directory = await mkdtemp(
      'E:\\Dev\\Temp\\opencode\\agent-profile-process-',
    ),
    registry = join(directory, 'state.json'),
    clients: Client[] = [];
  const persist = async () => {
    await writeFile(
      join(directory, 'next.json'),
      JSON.stringify(await fixture.hub.inventory()),
    );
    await writeFile(
      join(directory, 'safety-next.json'),
      JSON.stringify(await fixture.hub.safety.read()),
    );
    await rename(
      join(directory, 'safety-next.json'),
      join(directory, 'safety.json'),
    );
    await rename(join(directory, 'next.json'), registry);
  };
  try {
    await apply(fixture.hub, {
      kind: 'set_agent_profile',
      agentId: 'cursor',
      profileId: 'profile',
    });
    await apply(fixture.hub, {
      kind: 'set_agent_profile',
      agentId: 'codex',
      profileId: 'operations',
    });
    await apply(fixture.hub, {
      kind: 'set_agent_profile',
      agentId: 'goose',
      profileId: 'profile',
    });
    await apply(fixture.hub, {
      kind: 'set_agent_tool_search',
      agentId: 'goose',
      toolSearchMode: true,
    });
    await persist();
    const launch = async (agentId: string) => {
      const client = new Client(
        { name: `synthetic-process-${agentId}`, version: '1' },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(
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
            registry,
            agentId,
          ],
          stderr: 'pipe',
        }),
        { timeout: 15_000 },
      );
      return client;
    };
    const cursor = await launch('cursor'),
      codex = await launch('codex'),
      a = await cursor.listTools(),
      b = await codex.listTools();
    const goose = await launch('goose');
    expect((await goose.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_tools',
      'call_tool',
    ]);
    const found = await goose.callTool({
      name: 'search_tools',
      arguments: { query: 'fixture' },
    });
    expect(
      (found.structuredContent as { tools: { name: string }[] }).tools.every(
        (tool) => tool.name.startsWith('connector-0__'),
      ),
    ).toBe(true);
    expect(a.tools).toHaveLength(3);
    expect(a.tools.every((tool) => tool.name.startsWith('connector-0__'))).toBe(
      true,
    );
    expect(b.tools.every((tool) => tool.name.startsWith('connector-1__'))).toBe(
      true,
    );
    expect(cursor.getServerCapabilities()).toMatchObject({
      resources: { subscribe: false, listChanged: true },
      prompts: { listChanged: true },
    });
    const resourcesA = await cursor.listResources(),
      resourcesB = await codex.listResources(),
      promptsA = await cursor.listPrompts(),
      promptsB = await codex.listPrompts();
    expect(resourcesA.resources).toHaveLength(1);
    expect(resourcesB.resources).toHaveLength(1);
    expect(resourcesA.resources[0]!.uri).not.toBe(resourcesB.resources[0]!.uri);
    expect(
      (await cursor.readResource({ uri: resourcesA.resources[0]!.uri }))
        .contents[0],
    ).toMatchObject({
      uri: resourcesA.resources[0]!.uri,
      text: 'Synthetic resource fixture://resource',
    });
    expect(
      (
        await codex.getPrompt({
          name: promptsB.prompts[0]!.name,
          arguments: { topic: 'SYNTHETIC-PRODUCTION-PROMPT-ARG' },
        })
      ).messages[0]!.content,
    ).toMatchObject({
      type: 'text',
      text: expect.stringContaining('SYNTHETIC-PRODUCTION-PROMPT-ARG'),
    });
    const template = (await cursor.listResourceTemplates())
        .resourceTemplates[0]!,
      expanded = new UriTemplate(template.uriTemplate).expand({
        key: 'report',
      });
    expect(
      (await cursor.readResource({ uri: expanded })).contents[0],
    ).toMatchObject({
      uri: expanded,
      text: 'Synthetic resource fixture://resource/report',
    });
    await expect(
      cursor.readResource({ uri: resourcesB.resources[0]!.uri }),
    ).rejects.toThrow();
    await expect(
      codex.getPrompt({ name: promptsA.prompts[0]!.name }),
    ).rejects.toThrow();
    let resourceNotices = 0,
      promptNotices = 0;
    cursor.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        resourceNotices++;
      },
    );
    cursor.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => {
        promptNotices++;
      },
    );
    let notified!: () => void;
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error('Production bridge did not notify its tool-list change.'),
          ),
        8000,
      );
      notified = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    cursor.setNotificationHandler(ToolListChangedNotificationSchema, async () =>
      notified(),
    );
    await apply(fixture.hub, {
      kind: 'set_agent_profile',
      agentId: 'cursor',
      profileId: 'operations',
    });
    await persist();
    const before = fixture.peers.map(
      (peer) => peer.methods.filter((method) => method === 'tools/call').length,
    );
    expect(
      await cursor.callTool({ name: 'connector-0__fixture_first' }),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'tool_scope_denied' }],
    });
    expect(
      fixture.peers.map(
        (peer) =>
          peer.methods.filter((method) => method === 'tools/call').length,
      ),
    ).toEqual(before);
    await changed;
    await expect
      .poll(() => resourceNotices >= 1 && promptNotices >= 1)
      .toBe(true);
    const beforeContent = fixture.peers.map(
      (peer) =>
        peer.methods.filter(
          (method) => method === 'resources/read' || method === 'prompts/get',
        ).length,
    );
    await expect(
      cursor.readResource({ uri: resourcesA.resources[0]!.uri }),
    ).rejects.toThrow();
    await expect(
      cursor.getPrompt({
        name: promptsA.prompts[0]!.name,
        arguments: { topic: 'SYNTHETIC-STALE-ARG' },
      }),
    ).rejects.toThrow();
    expect(
      fixture.peers.map(
        (peer) =>
          peer.methods.filter(
            (method) => method === 'resources/read' || method === 'prompts/get',
          ).length,
      ),
    ).toEqual(beforeContent);
    const moved = (await cursor.listResources()).resources[0]!;
    await cursor.readResource({ uri: moved.uri });
    expect((await cursor.listPrompts()).prompts[0]!.name).toMatch(
      /^connector-1__/,
    );
    expect(
      (await cursor.listTools()).tools.every((tool) =>
        tool.name.startsWith('connector-1__'),
      ),
    ).toBe(true);
    expect(
      await cursor.callTool({ name: 'connector-1__fixture_first' }),
    ).not.toHaveProperty('isError', true);
  } finally {
    for (const client of clients) await client.close();
    await fixture.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
}, 45_000);
