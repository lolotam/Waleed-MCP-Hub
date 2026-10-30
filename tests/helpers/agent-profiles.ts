import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createCapabilityRuntime,
  createAgentBridge,
  definitionHash,
  windowsAgentTargets,
  type HubLifecycle,
  createManagedPeerFactory,
} from '@waleed/hub-core';
import type { IntegrationAgentId } from '@waleed/contracts';
import { safeMcpHttpTransport } from '../../packages/hub-core/src/adapters/mcp/http.js';
import { profileState } from './runtime.js';
import { memoryStore } from './memory-store.js';
import { mcpHttpFixture } from './mcp-http.js';

export async function agentProfilesFixture(
  options: {
    echoArguments?: boolean;
    agentIds?: readonly IntegrationAgentId[];
  } = {},
) {
  const peers = await Promise.all([
      mcpHttpFixture(undefined, false, options.echoArguments),
      mcpHttpFixture(undefined, false, options.echoArguments),
    ]),
    state = profileState(['remote', 'remote']);
  for (const [index, connector] of state.connectors.entries()) {
    if (connector.executionMode !== 'remote') throw new Error();
    connector.endpoint = `${peers[index]!.origin}/mcp`;
    connector.localHttpOptIn = true;
    connector.trustApproval!.definitionHash = definitionHash(connector);
  }
  state.profiles[0]!.name = 'Research';
  state.profiles[0]!.connectorIds = ['connector-0'];
  state.profiles.push({
    ...state.profiles[0]!,
    id: 'operations',
    name: 'Operations',
    connectorIds: ['connector-1'],
  });
  const targets = windowsAgentTargets('C:\\SyntheticAgentSets', {}).filter(
    (target) => (options.agentIds ?? ['cursor', 'codex']).includes(target.id),
  );
  const sources = new Map(
    targets.map((target) => [
      target.paths[0]!,
      target.format === 'goose'
        ? '# Synthetic Goose settings\nGOOSE_MODE: approve\n'
        : target.format === 'codex'
          ? '# Synthetic Codex settings\nmodel = "synthetic"\n'
          : '{"theme":"keep","mcpServers":{}}',
    ]),
  );
  let writes = 0,
    backups = 0;
  const store = memoryStore(state),
    hub: HubLifecycle = createLifecycle(
      store,
      Date.now,
      createMemorySafetyLedger(),
      {
        playgroundConnect: createManagedPeerFactory(
          'unused-http-playground',
          () => store.read(),
        ),
        runtime: createCapabilityRuntime({
          workingDirectory: 'unused-agent-profile-http-only',
        }),
        integrations: {
          targets,
          files: {
            read: async (path) => sources.get(path) ?? null,
            async replace(path, before, after) {
              if (sources.get(path) !== before)
                throw new Error('Synthetic file changed.');
              sources.set(path, after);
              writes++;
            },
            async backup(agentId) {
              backups++;
              return `C:\\SyntheticAgentSets\\backups\\${agentId}.bak`;
            },
          },
          node: process.execPath,
          registry: 'C:\\SyntheticAgentSets\\state.json',
          discovery: {
            find: async (names) => [`C:\\SyntheticAgentSets\\${names[0]}.exe`],
            read: async () => ({ status: 'missing' }),
            run: async () => {
              throw new Error('No agent execution.');
            },
          },
        },
      },
    );
  for (const connector of state.connectors) {
    const job = await hub.checks.start(connector.id, 'fixture');
    await hub.checks.drain();
    if (hub.checks.job(job.id, 'fixture').state !== 'succeeded')
      throw new Error('Synthetic discovery failed.');
  }
  const scan = await hub.integrations.scan();
  for (const agent of scan.agents)
    await hub.integrations.integrate(agent.agentId, {
      expectedRevision: (await hub.inventory()).revision,
      fingerprint: agent.fingerprint,
      confirmConfigurationChange: true,
    });
  const agents = new Map<
    IntegrationAgentId,
    { client: Client; bridge: ReturnType<typeof createAgentBridge> }
  >();
  for (const agentId of ['cursor', 'codex'] as const) {
    const bridge = createAgentBridge(
      () => store.read(),
      async (connector, signal) => {
        if (connector.executionMode !== 'remote') throw new Error();
        const client = new Client(
            { name: 'synthetic-agent-profile-peer', version: '1' },
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
      agentId,
      {},
      hub.requestLog,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    const client = new Client(
      { name: `synthetic-${agentId}`, version: '1' },
      { capabilities: {} },
    );
    await client.connect(b);
    agents.set(agentId, { client, bridge });
  }
  return {
    hub,
    store,
    peers,
    agents,
    sources,
    fileEffects: () => ({ writes, backups }),
    async close(closeHub = true) {
      for (const { client, bridge } of agents.values()) {
        await client.close();
        await bridge.close();
      }
      for (const peer of peers) await peer.close();
      if (closeHub) await hub.close();
    },
  };
}
