import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Resource,
  type ResourceTemplate,
  type Prompt,
  type ReadResourceResult,
  type GetPromptResult,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { createAgentBridge } from '@waleed/hub-core';
import type { IntegrationAgentId } from '@waleed/contracts';
import { assertNoCredentialEcho } from '../../packages/hub-core/src/integrations/bridge.js';
import { profileState } from './runtime.js';

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export async function contentFixture(count = 2) {
  const state = profileState(
    Array.from({ length: count }, () => 'native' as const),
  );
  const definitions = state.connectors.map((_connector, index) => ({
    resources: [
      {
        name: `document-${index}`,
        uri: 'fixture://same',
        mimeType: 'text/plain',
      },
    ] as Resource[],
    templates: [
      {
        name: `template-${index}`,
        uriTemplate: 'fixture://files/{key}{?format}',
      },
    ] as ResourceTemplate[],
    prompts: [
      {
        name: 'summarize',
        description: `prompt-${index}`,
        arguments: [{ name: 'topic', required: true }],
      },
    ] as Prompt[],
    capabilities: {
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
    } as ServerCapabilities,
    errors: new Set<string>(),
    secret: undefined as string | undefined,
    providerError: undefined as Error | undefined,
    result: undefined as ReadResourceResult | undefined,
    promptResult: undefined as GetPromptResult | undefined,
    gate: undefined as ReturnType<typeof deferred> | undefined,
    listGate: undefined as ReturnType<typeof deferred> | undefined,
    startupGate: undefined as ReturnType<typeof deferred> | undefined,
    cursor: false,
  }));
  const requests: Array<{
      connectorId: string;
      method: string;
      params: unknown;
    }> = [],
    starts: string[] = [],
    servers: Server[] = [],
    agents: Array<{
      agent: Client;
      bridge: ReturnType<typeof createAgentBridge>;
    }> = [];
  const connect = async (connector: (typeof state.connectors)[number]) => {
    const index = state.connectors.findIndex(
        (item) => item.id === connector.id,
      ),
      definition = definitions[index]!;
    starts.push(connector.id);
    await definition.startupGate?.promise;
    const server = new Server(
      { name: `synthetic-content-${index}`, version: '1' },
      { capabilities: definition.capabilities },
    );
    servers.push(server);
    const seen = async (method: string, params: unknown) => {
      requests.push({
        connectorId: connector.id,
        method,
        params: structuredClone(params),
      });
      if (definition.errors.has(method))
        throw (
          definition.providerError ??
          new Error('SYNTHETIC-PRIVATE-PROVIDER-ERROR')
        );
    };
    if (definition.capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
        await seen('resources/list', request.params);
        await definition.listGate?.promise;
        return {
          resources: definition.resources,
          ...(definition.cursor ? { nextCursor: 'repeat' } : {}),
        };
      });
      server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async (request) => {
          await seen('resources/templates/list', request.params);
          await definition.listGate?.promise;
          return { resourceTemplates: definition.templates };
        },
      );
      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        await seen('resources/read', request.params);
        await definition.gate?.promise;
        return (
          definition.result ?? {
            contents: [
              {
                uri: request.params.uri,
                text: `connector-${index} resource ${request.params.uri}`,
              },
            ],
          }
        );
      });
    }
    if (definition.capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
        await seen('prompts/list', request.params);
        await definition.listGate?.promise;
        return { prompts: definition.prompts };
      });
      server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        await seen('prompts/get', request.params);
        await definition.gate?.promise;
        return (
          definition.promptResult ?? {
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `connector-${index} prompt ${JSON.stringify(request.params.arguments ?? {})}`,
                },
              },
            ],
          }
        );
      });
    }
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client(
      { name: 'synthetic-content-hub', version: '1' },
      { capabilities: {} },
    );
    await client.connect(b);
    return {
      client,
      assertPublic(value: unknown) {
        assertNoCredentialEcho(
          value,
          definition.secret ? [definition.secret] : [],
        );
      },
      async dispose() {
        await client.close();
        await server.close();
      },
    };
  };
  let readFailure = false;
  const launch = async (
    agentId: IntegrationAgentId = 'cursor',
    options = {},
  ) => {
    const bridge = createAgentBridge(
        async () => {
          if (readFailure) throw new Error('SYNTHETIC-PRIVATE-REGISTRY');
          return structuredClone(state);
        },
        connect,
        agentId,
        options,
      ),
      [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    const agent = new Client(
      { name: `synthetic-content-${agentId}`, version: '1' },
      { capabilities: {} },
    );
    await agent.connect(b);
    agents.push({ agent, bridge });
    return { agent, bridge };
  };
  const primary = await launch();
  return {
    ...primary,
    state,
    definitions,
    requests,
    starts,
    servers,
    launch,
    failRead() {
      readFailure = true;
    },
    async close() {
      for (const definition of definitions) {
        definition.gate?.resolve();
        definition.listGate?.resolve();
        definition.startupGate?.resolve();
      }
      for (const { agent, bridge } of agents) {
        await agent.close();
        await bridge.close();
      }
    },
  };
}
