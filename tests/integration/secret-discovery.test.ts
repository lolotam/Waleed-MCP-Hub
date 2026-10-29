import { afterEach, describe, expect, it } from 'vitest';
import {
  createBindingResolver,
  createCapabilityRuntime,
  createLifecycle,
  createMemorySafetyLedger,
  definitionHash,
} from '@waleed/hub-core';
import { mcpHttpFixture } from '../helpers/mcp-http.js';
import { profileState } from '../helpers/runtime.js';
import { memoryStore } from '../helpers/memory-store.js';
import { memorySecrets } from '../helpers/secrets.js';

const fixtures: Awaited<ReturnType<typeof mcpHttpFixture>>[] = [];
const memories: ReturnType<typeof memorySecrets>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const memory of memories.splice(0)) memory.close();
});
describe('disposable secret-backed real MCP discovery', () => {
  it.each([false, true])(
    'forwards declared headers only and rejects credential-echo metadata (echo=%s)',
    async (echo) => {
      const secret = 'SYNTHETIC_PRIVATE_TOKEN_0123456789';
      const peer = await mcpHttpFixture(`Bearer ${secret}`, echo);
      fixtures.push(peer);
      const store = memoryStore(profileState(['remote']));
      const secrets = memorySecrets();
      memories.push(secrets);
      const runtime = createCapabilityRuntime({
        workingDirectory: 'unused-http-only',
        fixtureOrigin: peer.origin,
        resolveBindings: createBindingResolver(
          { windows: secrets.backend },
          () => store.read(),
        ),
      });
      // Production URLs remain HTTPS; the exact loopback exception is injected at
      // construction only, including a fixture-local endpoint through this adapter.
      const wrapped = {
        discover: (
          connector: Parameters<typeof runtime.discover>[0],
          signal: AbortSignal,
        ) =>
          runtime.discover(
            {
              ...connector,
              executionMode: 'remote',
              transport: 'streamable_http',
              endpoint: `${peer.origin}/mcp`,
            },
            signal,
          ),
      };
      const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
        runtime: wrapped,
        secrets: { windows: secrets.backend },
      });
      const receipt = await hub.auth.credentials.write('connector-0', {
        expectedRevision: 0,
        expectedConnectorRevision: 1,
        location: 'header',
        name: 'Authorization',
        format: 'bearer',
        adapter: 'windows',
        value: secret,
      });
      expect((await hub.checks.observations())[0]?.state).toBe('untested');
      await expect(
        hub.checks.start('connector-0', 'owner'),
      ).rejects.toMatchObject({ code: 'conflict' });
      const connector = (await hub.inventory()).connectors[0]!;
      const approval = await hub.preview(
        {
          kind: 'approve_connector',
          expectedRevision: 1,
          connectorId: connector.id,
          expectedConnectorRevision: 2,
          definitionHash: definitionHash(connector),
          approveExecution: true,
        },
        'owner',
      );
      await hub.apply(approval.id, 'owner');
      await hub.drain();
      const job = await hub.checks.start('connector-0', 'owner');
      await hub.checks.drain();
      expect(hub.checks.job(job.id, 'owner').state).toBe(
        echo ? 'failed' : 'succeeded',
      );
      expect(
        JSON.stringify([
          receipt,
          await hub.inventory(),
          await hub.checks.observations(),
        ]),
      ).not.toContain(secret);
      expect(peer.methods).not.toContain('tools/call');
      expect(
        secrets.reads.every((value) => value.every((byte) => byte === 0)),
      ).toBe(true);
      await hub.close();
    },
  );
});
