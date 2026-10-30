import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import {
  createAgentBridge,
  createWindowsProcessRunner,
  definitionHash,
} from '@waleed/hub-core';
import { ContainedStdioTransport } from '../../packages/hub-core/src/adapters/mcp/stdio.js';
import { profileState } from '../helpers/runtime.js';

it.skipIf(process.platform !== 'win32')(
  'retains a real contained native MCP and reaps its complete process tree on agent disconnect',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hub-persistent-native-'));
    const state = profileState(['native']);
    const connector = state.connectors[0]!;
    if (connector.executionMode !== 'native') throw new Error();
    connector.executable = process.execPath;
    connector.arguments = [
      fileURLToPath(new URL('../fixtures/mcp-persistent.mjs', import.meta.url)),
      join(directory, 'pids.json'),
    ];
    connector.trustApproval!.definitionHash = definitionHash(connector);
    let starts = 0,
      ended = 0;
    const runner = await createWindowsProcessRunner({
      allowedExecutables: [process.execPath],
      workingDirectory: directory,
      concurrency: 1,
    });
    const bridge = createAgentBridge(
      async () => structuredClone(state),
      async (_connector, signal) => {
        starts++;
        const client = new Client(
          { name: 'synthetic-native-parent', version: '1' },
          { capabilities: {} },
        );
        const transport = new ContainedStdioTransport(
          runner,
          {
            executable: process.execPath,
            arguments: connector.arguments,
            environment: {},
            timeoutMs: 3_600_000,
            session: true,
            outputLimitBytes: 1024 * 1024,
          },
          signal,
        );
        try {
          await client.connect(transport, { timeout: 20_000 });
        } catch (error) {
          await transport.close();
          throw error;
        }
        return {
          client,
          assertPublic() {},
          async dispose() {
            try {
              await client.close();
            } finally {
              await transport.close();
              ended++;
            }
          },
        };
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    const agent = new Client(
      { name: 'synthetic-agent', version: '1' },
      { capabilities: {} },
    );
    await agent.connect(b);
    try {
      expect((await agent.listTools()).tools).toHaveLength(2);
      await agent.callTool({ name: 'connector-0__open-session' });
      await agent.listTools();
      expect(
        await agent.callTool({ name: 'connector-0__read-session-output' }),
      ).toMatchObject({ content: [{ text: 'synthetic session retained' }] });
      expect(starts).toBe(1);
      const pids = JSON.parse(
        await readFile(join(directory, 'pids.json'), 'utf8'),
      ) as { root: number; child: number };
      for (const pid of [pids.root, pids.child])
        expect(() => process.kill(pid, 0)).not.toThrow();
      await agent.close();
      await bridge.close();
      expect(ended).toBe(1);
      expect(await readFile(join(directory, 'pids.json.closed'), 'utf8')).toBe(
        'graceful EOF',
      );
      for (const pid of [pids.root, pids.child])
        expect(() => process.kill(pid, 0)).toThrow();
      // Long-lived mode cannot be used to bypass ordinary command deadlines.
      await expect(
        runner.run({
          executable: process.execPath,
          arguments: [],
          environment: {},
          timeoutMs: 3_600_000,
          outputLimitBytes: 1024,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    } finally {
      await agent.close();
      await bridge.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
  40_000,
);
