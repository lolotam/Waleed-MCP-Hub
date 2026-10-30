import { readFile, lstat } from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  StateSchema,
  SafetyStateSchema,
  IntegrationAgentIdSchema,
  type Connector,
  type HubState,
} from '@waleed/contracts';
import { assertNoLinks } from '../adapters/managed-files.js';
import { windowsSecretStore } from '../adapters/secrets/windows.js';
import { createBindingResolver, type SecretLease } from '../auth/bindings.js';
import { safeMcpHttpTransport } from '../adapters/mcp/http.js';
import { ContainedStdioTransport } from '../adapters/mcp/stdio.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import { isolatedNativeArguments } from '../adapters/mcp/runtime.js';
import { approved, definitionHash, hashData } from '../runtime/registry.js';
import { dockerAgentTransport } from './docker-transport.js';
import { packagesRoot } from '../packages/store.js';
import { verifyPackage } from '../packages/verify.js';

export interface BridgePeer {
  client: Client;
  dispose(): Promise<void>;
  assertPublic(value: unknown): void;
}
// Provider cleanup diagnostics can contain credentials. Recovery evidence stays
// local; a failed peer must never expose a raw SDK/process error to an agent.
async function disposePeer(peer: BridgePeer | undefined) {
  try {
    await peer?.dispose();
  } catch {
    /* Scoped Docker markers remain blocking. */
  }
}
export function assertNoCredentialEcho(value: unknown, secrets: string[]) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
  for (const secret of secrets.flatMap((value) => [
    value,
    value.replace(/^(?:Bearer|Basic)\s+/i, ''),
  ])) {
    if (
      secret &&
      [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString('base64'),
      ].some((item) => text.includes(JSON.stringify(item).slice(1, -1)))
    )
      throw new Error();
  }
}
// Agents prefix bridge tools (e.g. `mcp__waleed-mcp-hub__`, 21 chars) and cap
// the full name at 64, so readable names stay within 40 characters.
const toolNameLimit = 40;
const slug = (value: string) =>
  value
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
export function bridgeToolName(
  connector: Pick<Connector, 'id' | 'name'>,
  tool: string,
  taken: ReadonlySet<string>,
) {
  const name = `${slug(connector.name).toLowerCase() || 'connector'}__${slug(tool) || 'tool'}`;
  if (name.length <= toolNameLimit && !taken.has(name)) return name;
  // Too long or colliding: keep the readable prefix and add a stable short hash.
  const suffix = `_${hashData([connector.id, tool]).slice(0, 6)}`;
  return `${name.slice(0, toolNameLimit - suffix.length).replace(/[_-]+$/, '')}${suffix}`;
}
export function createAgentBridge(
  read: () => Promise<HubState>,
  connect: (connector: Connector, signal: AbortSignal) => Promise<BridgePeer>,
) {
  const server = new Server(
    { name: 'waleed-mcp-hub', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const names = new Map<
    string,
    { connectorId: string; hash: string; name: string }
  >();
  let active = 0;
  const readState = async () => {
    try {
      return await read();
    } catch {
      throw new Error(
        'The managed hub registry is unavailable. Inspect local recovery.',
      );
    }
  };
  const admitted = async <T>(action: () => Promise<T>) => {
    if (active >= 2) throw new Error('Hub request concurrency limit reached.');
    active++;
    try {
      return await action();
    } finally {
      active--;
    }
  };
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) =>
    admitted(async () => {
      const signal = AbortSignal.any([
        extra.signal,
        AbortSignal.timeout(45000),
      ]);
      const state = await readState();
      const tools: Tool[] = [];
      names.clear();
      for (const connector of state.connectors.filter(
        (item) => item.enabled && approved(item),
      )) {
        if (signal.aborted) break;
        let peer: BridgePeer | undefined;
        try {
          const peerSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(20000),
          ]);
          peer = await connect(connector, peerSignal);
          let cursor: string | undefined;
          for (let page = 0; page < 8; page++) {
            const result = await peer.client.listTools(
              cursor ? { cursor } : {},
              { signal: peerSignal, timeout: 20000 },
            );
            peer.assertPublic(result);
            for (const tool of result.tools) {
              if (tools.length >= 256) break;
              const name = bridgeToolName(
                connector,
                tool.name,
                new Set(names.keys()),
              );
              names.set(name, {
                connectorId: connector.id,
                hash: definitionHash(connector),
                name: tool.name,
              });
              tools.push({
                ...tool,
                name,
                description:
                  `${connector.name}: ${tool.description ?? tool.name}`.slice(
                    0,
                    1000,
                  ),
              });
            }
            if (!result.nextCursor || tools.length >= 256) break;
            cursor = result.nextCursor;
          }
        } catch {
          /* Isolate unavailable/auth-required peers; never reflect diagnostics. */
        } finally {
          await disposePeer(peer);
        }
        if (tools.length >= 256) break;
      }
      return { tools };
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    admitted(async () => {
      const target = names.get(request.params.name);
      if (!target)
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Refresh the hub tool list before using this tool.',
            },
          ],
        };
      let peer: BridgePeer | undefined;
      try {
        const state = await readState();
        const connector = state.connectors.find(
          (item) => item.id === target.connectorId,
        );
        if (
          !connector?.enabled ||
          !approved(connector) ||
          definitionHash(connector) !== target.hash
        )
          throw new Error();
        const signal = AbortSignal.any([
          extra.signal,
          AbortSignal.timeout(60000),
        ]);
        peer = await connect(connector, signal);
        // Recheck approval after startup, immediately before the explicit call.
        const latest = (await readState()).connectors.find(
          (item) => item.id === connector.id,
        );
        if (
          !latest?.enabled ||
          !approved(latest) ||
          definitionHash(latest) !== target.hash
        )
          throw new Error();
        const result = await peer.client.callTool(
          {
            name: target.name,
            arguments: request.params.arguments,
          },
          undefined,
          { signal, timeout: 60000 },
        );
        peer.assertPublic(result);
        return result;
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'The connector is unavailable, changed, disabled, or requires authentication. Inspect the hub and refresh tools.',
            },
          ],
        };
      } finally {
        await disposePeer(peer);
      }
    }),
  );
  return server;
}
async function readProtectedJson(path: string) {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)
    throw new Error();
  const bytes = await readFile(path);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally {
    bytes.fill(0);
  }
}
export async function runAgentBridge(registry: string, agentId: string) {
  IntegrationAgentIdSchema.parse(agentId);
  const directory = dirname(registry);
  const read = async () => {
    const ledger = SafetyStateSchema.parse(
      await readProtectedJson(join(directory, 'safety.json')),
    );
    if (
      ledger.operations.some(
        (item) => item.phase === 'prepared' || item.phase === 'needs_review',
      )
    )
      throw new Error();
    const state = StateSchema.parse(await readProtectedJson(registry));
    if (!state.integrations?.some((item) => item.agentId === agentId))
      throw new Error();
    return state;
  };
  let backend: ReturnType<typeof windowsSecretStore> | undefined;
  const connect = async (
    connector: Connector,
    signal: AbortSignal,
  ): Promise<BridgePeer> => {
    let lease: SecretLease | undefined;
    const client = new Client(
      { name: 'waleed-managed-agent', version: '0.1.0' },
      { capabilities: {} },
    );
    let docker: Awaited<ReturnType<typeof dockerAgentTransport>> | undefined;
    try {
      // A managed install is verified before the secret is resolved and before
      // any process starts.
      if (connector.executionMode === 'native' && connector.package)
        await verifyPackage(connector, packagesRoot(directory));
      const bound =
        Object.keys(connector.secretBindings).length ||
        Object.keys(connector.headerBindings).length;
      if (bound) {
        backend ??= windowsSecretStore(join(directory, 'credentials'), true);
        lease = await createBindingResolver({ windows: await backend }, read)(
          connector,
          signal,
        );
      }
      if (connector.executionMode === 'docker') {
        docker = await dockerAgentTransport(connector, directory, signal);
        await client.connect(docker.transport, { timeout: 20000 });
      } else if (connector.executionMode === 'remote')
        await client.connect(
          safeMcpHttpTransport(
            connector.endpoint,
            connector.transport,
            signal,
            undefined,
            lease?.headers,
          ),
          { timeout: 20000 },
        );
      else {
        const runner = await createWindowsProcessRunner({
          allowedExecutables: [connector.executable],
          workingDirectory: directory,
          concurrency: 1,
        });
        await client.connect(
          new ContainedStdioTransport(
            runner,
            {
              executable: connector.executable,
              arguments: isolatedNativeArguments(connector),
              environment: {
                ...connector.environmentLiterals,
                ...lease?.environment,
              },
              timeoutMs: 120000,
              outputLimitBytes: 1024 * 1024,
            },
            signal,
          ),
          { timeout: 20000 },
        );
      }
      return {
        client,
        async dispose() {
          try {
            await client.close();
          } finally {
            try {
              await docker?.dispose();
            } finally {
              lease?.dispose();
            }
          }
        },
        assertPublic(value) {
          assertNoCredentialEcho(value, [
            ...Object.values(lease?.environment ?? {}),
            ...Object.values(lease?.headers ?? {}),
          ]);
        },
      };
    } catch (error) {
      try {
        await client.close();
      } finally {
        try {
          await docker?.dispose();
        } finally {
          lease?.dispose();
        }
      }
      throw error;
    }
  };
  await read();
  const server = createAgentBridge(read, connect);
  await server.connect(new StdioServerTransport());
  const changed = () => {
    void server.sendToolListChanged().catch(() => undefined);
  };
  watchFile(registry, { interval: 1000, persistent: false }, changed);
  const close = () => {
    unwatchFile(registry, changed);
    void server.close();
  };
  process.stdin.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runAgentBridge(process.argv[2] ?? '', process.argv[3] ?? '').catch(
    () => {
      process.stderr.write(
        'The managed hub bridge is unavailable or disconnected. Inspect local recovery and agent registration.\n',
      );
      process.exitCode = 1;
    },
  );
}
