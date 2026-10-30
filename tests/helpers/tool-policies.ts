import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createCapabilityRuntime,
  createAgentBridge,
  definitionHash,
} from '@waleed/hub-core';
import { safeMcpHttpTransport } from '../../packages/hub-core/src/adapters/mcp/http.js';
import { mcpHttpFixture } from './mcp-http.js';
import { memoryStore } from './memory-store.js';
import { profileState } from './runtime.js';

export async function toolPolicyFixture() {
  const peer = await mcpHttpFixture(),
    state = profileState(['remote']),
    connector = state.connectors[0]!;
  if (connector.executionMode !== 'remote') throw new Error();
  connector.endpoint = `${peer.origin}/mcp`;
  connector.localHttpOptIn = true;
  connector.trustApproval!.definitionHash = definitionHash(connector);
  const store = memoryStore(state),
    hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      runtime: createCapabilityRuntime({
        workingDirectory: 'unused-policy-http-only',
      }),
    });
  const job = await hub.checks.start(connector.id, 'fixture');
  await hub.checks.drain();
  if (hub.checks.job(job.id, 'fixture').state !== 'succeeded')
    throw new Error('Synthetic discovery failed.');
  const bridge = createAgentBridge(
    () => store.read(),
    async (connector, signal) => {
      if (connector.executionMode !== 'remote') throw new Error();
      const client = new Client(
          { name: 'policy-fixture-peer', version: '1' },
          { capabilities: {} },
        ),
        transport = safeMcpHttpTransport(
          connector.endpoint,
          connector.transport,
          signal,
          undefined,
          {},
          true,
        );
      await client.connect(transport);
      return {
        client,
        assertPublic() {},
        async dispose() {
          await client.close();
          await transport.close();
        },
      };
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const agent = new Client(
    { name: 'policy-fixture-agent', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  let answer: ElicitResult = { action: 'decline' },
    prompts = 0;
  agent.setRequestHandler(ElicitRequestSchema, async () => {
    prompts++;
    return structuredClone(answer);
  });
  await agent.connect(b);
  return {
    hub,
    store,
    peer,
    agent,
    bridge,
    setAnswer(value: ElicitResult) {
      answer = value;
    },
    prompts: () => prompts,
    async close(closeHub = true) {
      await agent.close();
      await bridge.close();
      await peer.close();
      if (closeHub) await hub.close();
    },
  };
}
