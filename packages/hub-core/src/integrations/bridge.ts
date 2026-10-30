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
  HttpClientAgentIdSchema,
  ToolPolicySchema,
  ToolPolicyNameSchema,
  SearchToolsArgumentsSchema,
  CallToolArgumentsSchema,
  SearchToolsResultSchema,
  type Connector,
  type HubState,
  type HttpClientAgentId,
  MANAGED_BRIDGE_CAPABILITIES,
} from '@waleed/contracts';
import { assertNoLinks } from '../adapters/managed-files.js';
import { createPlatformCredentialStorage } from '../adapters/secrets/platform.js';
import { createBindingResolver, type SecretLease } from '../auth/bindings.js';
import { safeMcpHttpTransport } from '../adapters/mcp/http.js';
import { ContainedStdioTransport } from '../adapters/mcp/stdio.js';
import { createPlatformProcessRunner } from '../adapters/native/platform-runner.js';
import { isolatedNativeArguments } from '../adapters/mcp/runtime.js';
import { approved, definitionHash, hashData } from '../runtime/registry.js';
import { dockerAgentTransport } from './docker-transport.js';
import { localPackageRuntime } from '../adapters/packages.js';
import { createMcpbAdapter } from '../adapters/mcpb.js';
import { createPeerSessions, bridgeSessionLimits } from './peer-sessions.js';
import { createRemoteCredentials } from '../auth/remote-credentials.js';
import { createRequestLog, type RequestLog } from './request-log.js';
import { createRequestLogSender } from './request-log-ipc.js';
import { createBridgeContent } from './bridge-content.js';
import { bridgeToolName } from './tool-names.js';
export { bridgeToolName } from './tool-names.js';
import { findToolOverride, toolOverrideHash } from './tool-overrides.js';
import {
  agentCanAccessConnector,
  agentToolSearchMode,
} from './agent-profiles.js';
import {
  toolSearchMetaTools,
  rankedSearch,
  SEARCH_CATALOG_LIMIT,
  SEARCH_CATALOG_BYTES,
  SEARCH_RESULT_BYTES,
} from './tool-search.js';

export interface BridgePeer {
  client: Client;
  expiresAt?: number;
  dispose(): Promise<void>;
  assertPublic(value: unknown): void;
}
export function assertNoCredentialEcho(value: unknown, secrets: string[]) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
  for (const secret of secrets.flatMap((value) => {
    const variants = [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')];
    if (/^Basic\s+/i.test(value)) {
      const bytes = Buffer.from(value.replace(/^Basic\s+/i, ''), 'base64');
      try {
        variants.push(bytes.toString('utf8'));
      } finally {
        bytes.fill(0);
      }
    }
    return variants;
  })) {
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
type ToolRoute = {
  connectorId: string;
  hash: string;
  name: string;
  overrideHash: string;
};
export function toolPolicy(connector: Connector, name: string) {
  if (!ToolPolicyNameSchema.safeParse(name).success) return 'block';
  const policies = connector.toolPolicies ?? {};
  // An upstream readOnlyHint is untrusted metadata, never permission to bypass
  // an explicit policy. Missing policies retain legacy Allow behavior.
  if (!Object.hasOwn(policies, name)) return 'allow';
  const parsed = ToolPolicySchema.safeParse(policies[name]);
  return parsed.success ? parsed.data : 'block';
}
const refusals = new WeakMap<object, 'blocked' | 'declined' | 'error'>();
const toolRefusal = (code: string) => {
  const result = {
    isError: true,
    content: [{ type: 'text' as const, text: code }],
    structuredContent: { error: code },
  };
  refusals.set(
    result,
    code === 'tool_approval_denied'
      ? 'declined'
      : [
            'tool_blocked',
            'tool_scope_denied',
            'tool_approval_required',
            'tool_approval_stale',
            'tool_search_required',
            'tool_search_disabled',
            'tool_search_recursion_denied',
            'tool_search_mode_changed',
            'tool_override_stale',
            'tool_alias_conflict',
          ].includes(code)
        ? 'blocked'
        : 'error',
  );
  return result;
};
export function createAgentBridge(
  read: () => Promise<HubState>,
  connect: (connector: Connector, signal: AbortSignal) => Promise<BridgePeer>,
  agentOrOptions?: HttpClientAgentId | Partial<typeof bridgeSessionLimits>,
  sessionOptions: Partial<typeof bridgeSessionLimits> = {},
  requestLog: RequestLog = createRequestLog(),
) {
  if (
    agentOrOptions !== undefined &&
    (agentOrOptions === null ||
      !['string', 'object'].includes(typeof agentOrOptions))
  )
    throw new Error('Invalid agent bridge target.');
  const agentId =
    typeof agentOrOptions === 'string'
      ? HttpClientAgentIdSchema.parse(agentOrOptions)
      : undefined;
  const options =
    agentOrOptions && typeof agentOrOptions === 'object'
      ? agentOrOptions
      : sessionOptions;
  const server = new Server(
    { name: 'waleed-mcp-hub', version: '0.1.0' },
    { capabilities: structuredClone(MANAGED_BRIDGE_CAPABILITIES) },
  );
  const names = new Map<string, ToolRoute>();
  const snapshots = new WeakMap<Tool, ToolRoute>();
  let currentNames = new Set<string>();
  let currentConflicts = new Set<string>();
  const sameTarget = (a: ToolRoute, b: ToolRoute) =>
    a.connectorId === b.connectorId && a.name === b.name;
  const overrideCurrent = (state: HubState, target: ToolRoute) =>
    toolOverrideHash(state, target.connectorId, target.name) ===
    target.overrideHash;
  const aliasClaimChanged = (state: HubState, key: string, target: ToolRoute) =>
    (state.toolOverrides ?? []).some((item) => {
      const owner = state.connectors.find(
        (connector) => connector.id === item.connectorId,
      );
      return (
        item.alias === key &&
        owner?.enabled &&
        approved(owner) &&
        agentCanAccessConnector(state, agentId, item.connectorId) &&
        (item.connectorId !== target.connectorId ||
          item.originalToolName !== target.name)
      );
    });
  // Never recycle an advertised handle for another upstream tool, including
  // after removals, slug collisions or policy changes. Retention is bounded.
  const aliases = new Map<string, string>(),
    reserved = new Set<string>();
  const sessions = createPeerSessions(read, connect, options, agentId);
  const close = server.close.bind(server);
  let closing: Promise<void> | undefined;
  server.close = () =>
    (closing ??= (async () => {
      content.close();
      await sessions.close();
      await close();
    })());
  server.onclose = () => {
    void server.close().catch(() => undefined);
  };
  let active = 0;
  const readState = async () => {
    try {
      return await read();
    } catch {
      await sessions.reconcile(null);
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
  const content = createBridgeContent(
    server,
    readState,
    sessions,
    admitted,
    agentId,
  );
  const filterVisible = (state: HubState, tools: Tool[]) => {
    const connectors = new Map(
        state.connectors.map((connector) => [connector.id, connector]),
      ),
      grants = new Map<string, string | undefined>();
    return tools.filter((tool) => {
      const target = snapshots.get(tool),
        connector = target ? connectors.get(target.connectorId) : undefined;
      if (!target || !connector) return false;
      if (!grants.has(connector.id)) {
        const hash =
          connector.enabled &&
          agentCanAccessConnector(state, agentId, connector.id)
            ? definitionHash(connector)
            : undefined;
        grants.set(
          connector.id,
          hash &&
            connector.trustApproval?.revision === connector.revision &&
            connector.trustApproval.definitionHash === hash
            ? hash
            : undefined,
        );
      }
      return (
        grants.get(connector.id) === target.hash &&
        overrideCurrent(state, target) &&
        !currentConflicts.has(tool.name) &&
        !aliasClaimChanged(state, tool.name, target) &&
        toolPolicy(connector, target.name) !== 'block'
      );
    });
  };
  const discoverTools = async (
    state: HubState,
    signal: AbortSignal,
    limit = 256,
  ) => {
    await sessions.reconcile(state);
    let bytes = 0,
      truncated = false;
    const tools: Tool[] = [];
    const candidates: Array<{
      canonical: string;
      route: ToolRoute;
      alias: string | undefined;
      overridden: boolean;
    }> = [];
    const discovered = new Map<string, ToolRoute>();
    for (const connector of state.connectors.filter(
      (item) =>
        item.enabled &&
        approved(item) &&
        agentCanAccessConnector(state, agentId, item.id),
    )) {
      if (signal.aborted) break;
      const connectorHash = definitionHash(connector);
      try {
        const peerSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(20000),
        ]);
        await sessions.use(
          connector,
          state,
          peerSignal,
          async (peer, signal) => {
            let cursor: string | undefined;
            for (let page = 0; page < 8; page++) {
              const result = await peer.client.listTools(
                cursor ? { cursor } : {},
                { signal, timeout: 20000 },
              );
              peer.assertPublic(result);
              for (const tool of result.tools) {
                if (discovered.size >= limit) {
                  truncated = true;
                  break;
                }
                if (!ToolPolicyNameSchema.safeParse(tool.name).success)
                  continue;
                const identity = hashData([connector.id, tool.name]);
                let name = aliases.get(identity);
                if (!name) {
                  if (aliases.size >= SEARCH_CATALOG_LIMIT) {
                    truncated = true;
                    continue;
                  }
                  name = bridgeToolName(connector, tool.name, reserved);
                  if (reserved.has(name)) continue;
                  aliases.set(identity, name);
                  reserved.add(name);
                }
                if (discovered.has(name)) continue;
                discovered.set(name, {
                  connectorId: connector.id,
                  hash: connectorHash,
                  name: tool.name,
                  overrideHash: toolOverrideHash(
                    state,
                    connector.id,
                    tool.name,
                  ),
                });
                const route = discovered.get(name)!,
                  override = findToolOverride(state, connector.id, tool.name);
                candidates.push({
                  canonical: name,
                  route,
                  alias: override?.alias,
                  overridden: !!override,
                });
                const existing = names.get(name);
                if (!existing || sameTarget(existing, route))
                  names.set(name, route);
                if (toolPolicy(connector, tool.name) === 'block') continue;
                const published: Tool = {
                  ...tool,
                  name: override?.alias ?? name,
                  description:
                    override?.customDescription ??
                    `${connector.name}: ${tool.description ?? tool.name}`.slice(
                      0,
                      1000,
                    ),
                  ...(override?.annotations
                    ? {
                        annotations: {
                          ...tool.annotations,
                          ...structuredClone(override.annotations),
                        },
                      }
                    : {}),
                };
                bytes += Buffer.byteLength(JSON.stringify(published));
                if (bytes > SEARCH_CATALOG_BYTES) {
                  truncated = true;
                  break;
                }
                peer.assertPublic(published);
                snapshots.set(published, discovered.get(name)!);
                tools.push(published);
              }
              if (page === 7 && result.nextCursor) truncated = true;
              if (
                !result.nextCursor ||
                discovered.size >= limit ||
                bytes > SEARCH_CATALOG_BYTES
              )
                break;
              cursor = result.nextCursor;
            }
          },
        );
      } catch {
        truncated = true;
        /* Isolate unavailable/auth-required peers; never reflect diagnostics. */
      }
      if (discovered.size >= limit || bytes > SEARCH_CATALOG_BYTES) {
        truncated = true;
        break;
      }
    }
    // A policy may have changed while peer discovery was awaiting I/O. Never
    // publish a now-blocked tool from the earlier inventory snapshot.
    await sessions.reconcile(await readState());
    const latest = await readState();
    const conflicts = new Set<string>(),
      liveNames = new Set<string>();
    const owners = new Map<string, ToolRoute[]>();
    const claim = (key: string, route: ToolRoute) => {
      const values = owners.get(key) ?? [];
      if (!values.some((value) => sameTarget(value, route))) values.push(route);
      owners.set(key, values);
    };
    for (const candidate of candidates) {
      claim(candidate.canonical, candidate.route);
      if (candidate.alias) claim(candidate.alias, candidate.route);
    }
    for (const [key, values] of owners)
      if (values.length > 1) conflicts.add(key);
    for (const candidate of candidates)
      if (
        candidate.alias &&
        candidates.some(
          (other) =>
            other.route.name === candidate.alias &&
            !sameTarget(other.route, candidate.route),
        )
      )
        conflicts.add(candidate.alias);
    for (const candidate of candidates) {
      const unambiguousRaw =
        candidate.overridden &&
        !candidates.some(
          (other) =>
            other.route.name === candidate.route.name &&
            !sameTarget(other.route, candidate.route),
        );
      for (const key of [
        candidate.canonical,
        ...(candidate.alias ? [candidate.alias] : []),
        ...(unambiguousRaw ? [candidate.route.name] : []),
      ]) {
        if (['search_tools', 'call_tool'].includes(key)) continue;
        const previous = names.get(key);
        if (previous && !sameTarget(previous, candidate.route)) {
          conflicts.add(key);
          continue;
        }
        if (!conflicts.has(key) && names.size < SEARCH_CATALOG_LIMIT * 3) {
          names.set(key, candidate.route);
          liveNames.add(key);
        }
      }
    }
    currentConflicts = conflicts;
    currentNames = liveNames;
    return {
      tools: filterVisible(latest, tools),
      truncated: truncated || signal.aborted || conflicts.size > 0,
    };
  };
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) =>
    admitted(async () => {
      const signal = AbortSignal.any([
          extra.signal,
          AbortSignal.timeout(45000),
        ]),
        state = await readState();
      await sessions.reconcile(state);
      const current = await readState();
      if (agentToolSearchMode(current, agentId))
        return { tools: structuredClone(toolSearchMetaTools) };
      const catalog = await discoverTools(current, signal),
        latest = await readState();
      return {
        tools: agentToolSearchMode(latest, agentId)
          ? structuredClone(toolSearchMetaTools)
          : filterVisible(latest, catalog.tools),
        ...(currentConflicts.size
          ? { _meta: { 'wmh/overrideConflicts': true } }
          : {}),
      };
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const trace = requestLog.begin(agentId ?? 'hub_playground');
    let identity = { connectorId: 'hub_unknown', toolName: 'unknown_tool' };
    try {
      const result = await admitted(async () => {
        const requestSignal = AbortSignal.any([
          extra.signal,
          AbortSignal.timeout(60000),
        ]);
        let invocation: HubState;
        try {
          invocation = await readState();
        } catch {
          return toolRefusal('tool_unavailable');
        }
        const searchMode = agentToolSearchMode(invocation, agentId);
        let targetName = request.params.name,
          argumentsForCall = request.params.arguments;
        try {
          if (searchMode) {
            if (targetName === 'search_tools') {
              identity = { connectorId: 'hub_meta', toolName: 'search_tools' };
              const parsed =
                SearchToolsArgumentsSchema.safeParse(argumentsForCall);
              if (!parsed.success)
                return toolRefusal('tool_search_invalid_arguments');
              const catalog = await discoverTools(
                  invocation,
                  requestSignal,
                  SEARCH_CATALOG_LIMIT,
                ),
                latest = await readState();
              if (!agentToolSearchMode(latest, agentId))
                return toolRefusal('tool_search_mode_changed');
              const matches = rankedSearch(
                filterVisible(latest, catalog.tools),
                parsed.data.query,
                (name) => names.get(name)?.name ?? name,
              );
              const tools: Tool[] = [];
              let bytes = 128,
                truncated = catalog.truncated;
              for (const tool of matches.slice(0, parsed.data.limit)) {
                const size = Buffer.byteLength(JSON.stringify(tool));
                if (bytes + size > SEARCH_RESULT_BYTES) {
                  truncated = true;
                  break;
                }
                bytes += size;
                tools.push(tool);
              }
              const result = SearchToolsResultSchema.parse({
                tools,
                hasMore: matches.length > tools.length,
                truncated,
              });
              return {
                content: [
                  { type: 'text' as const, text: JSON.stringify(result) },
                ],
                structuredContent: result,
              };
            }
            if (targetName !== 'call_tool')
              return toolRefusal('tool_search_required');
            const parsed = CallToolArgumentsSchema.safeParse(argumentsForCall);
            if (!parsed.success)
              return toolRefusal('tool_search_invalid_arguments');
            targetName = parsed.data.name;
            argumentsForCall = parsed.data.arguments;
            if (targetName === 'search_tools' || targetName === 'call_tool')
              return toolRefusal('tool_search_recursion_denied');
            const known = names.get(targetName),
              knownConnector = invocation.connectors.find(
                (item) => item.id === known?.connectorId,
              );
            if (
              !currentNames.has(targetName) &&
              (!known ||
                (agentCanAccessConnector(
                  invocation,
                  agentId,
                  known.connectorId,
                ) &&
                  (!knownConnector ||
                    toolPolicy(knownConnector, known.name) !== 'block')))
            )
              await discoverTools(
                invocation,
                requestSignal,
                SEARCH_CATALOG_LIMIT,
              );
          } else if (
            targetName === 'search_tools' ||
            targetName === 'call_tool'
          ) {
            identity = { connectorId: 'hub_meta', toolName: targetName };
            return toolRefusal('tool_search_disabled');
          }
        } catch {
          return toolRefusal('tool_search_unavailable');
        }
        const target = names.get(targetName);
        if (target)
          identity = { connectorId: target.connectorId, toolName: target.name };
        if (currentConflicts.has(targetName))
          return toolRefusal('tool_alias_conflict');
        if (!target)
          return searchMode
            ? toolRefusal('tool_scope_denied')
            : {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: 'Refresh the hub tool list before using this tool.',
                  },
                ],
              };
        try {
          const state = await readState();
          if (aliasClaimChanged(state, targetName, target))
            return toolRefusal('tool_alias_conflict');
          if (agentToolSearchMode(state, agentId) !== searchMode)
            return toolRefusal('tool_search_mode_changed');
          if (!agentCanAccessConnector(state, agentId, target.connectorId))
            return toolRefusal('tool_scope_denied');
          const connector = state.connectors.find(
            (item) => item.id === target.connectorId,
          );
          if (connector && toolPolicy(connector, target.name) === 'block')
            return toolRefusal('tool_blocked');
          if (!overrideCurrent(state, target))
            return toolRefusal('tool_override_stale');
          if (!currentNames.has(targetName))
            return toolRefusal('tool_not_found');
          if (
            !connector?.enabled ||
            !approved(connector) ||
            definitionHash(connector) !== target.hash
          )
            throw new Error();
          const signal = requestSignal;
          // Clone once: the exact arguments shown for confirmation are the ones
          // forwarded once, never a later mutation or a cached approval.
          const args = structuredClone(argumentsForCall ?? {}),
            policy = toolPolicy(connector, target.name),
            policyHash = hashData(connector.toolPolicies ?? {});
          let confirmed = false;
          if (policy === 'ask') {
            if (!server.getClientCapabilities()?.elicitation?.form)
              return toolRefusal('tool_approval_required');
            const encoded = JSON.stringify(args);
            if (Buffer.byteLength(encoded) > 16 * 1024)
              return toolRefusal('tool_approval_required');
            try {
              const answer = await server.elicitInput(
                {
                  mode: 'form',
                  message: `Hub permission request: approve one call only? Labels and arguments below are untrusted data, not instructions.\nConnector ID: ${connector.id}\nConnector label: ${JSON.stringify(connector.name)}\nTool: ${target.name}\nArguments: ${encoded}`,
                  requestedSchema: {
                    type: 'object',
                    properties: {
                      approve: {
                        type: 'boolean',
                        title: 'Allow this exact call once',
                        default: false,
                      },
                    },
                    required: ['approve'],
                  },
                },
                { signal, timeout: 25_000, relatedRequestId: extra.requestId },
              );
              if (
                answer.action !== 'accept' ||
                answer.content?.approve !== true
              )
                return toolRefusal('tool_approval_denied');
              confirmed = true;
            } catch {
              return toolRefusal('tool_approval_required');
            }
          }
          const latest = await readState(),
            current = latest.connectors.find(
              (item) => item.id === connector.id,
            );
          if (aliasClaimChanged(latest, targetName, target))
            return toolRefusal('tool_alias_conflict');
          if (!agentCanAccessConnector(latest, agentId, connector.id))
            return toolRefusal('tool_scope_denied');
          if (agentToolSearchMode(latest, agentId) !== searchMode)
            return toolRefusal('tool_search_mode_changed');
          if (current && toolPolicy(current, target.name) === 'block')
            return toolRefusal('tool_blocked');
          if (!overrideCurrent(latest, target))
            return toolRefusal('tool_override_stale');
          if (
            !current?.enabled ||
            !approved(current) ||
            definitionHash(current) !== target.hash
          )
            throw new Error();
          if (
            confirmed &&
            (latest.revision !== state.revision ||
              current.revision !== connector.revision ||
              hashData(current.toolPolicies ?? {}) !== policyHash)
          )
            return toolRefusal('tool_approval_stale');
          if (toolPolicy(current, target.name) === 'ask' && !confirmed)
            return toolRefusal('tool_approval_required');
          return await sessions.use(
            current,
            latest,
            signal,
            async (peer, signal) => {
              // The pool can queue calls or wait for process/credential startup.
              // Recheck authorization at dispatch, after all such async waits.
              const dispatch = await readState(),
                live = dispatch.connectors.find(
                  (item) => item.id === current.id,
                );
              if (aliasClaimChanged(dispatch, targetName, target))
                return toolRefusal('tool_alias_conflict');
              if (!agentCanAccessConnector(dispatch, agentId, current.id))
                return toolRefusal('tool_scope_denied');
              if (agentToolSearchMode(dispatch, agentId) !== searchMode)
                return toolRefusal('tool_search_mode_changed');
              if (live && toolPolicy(live, target.name) === 'block')
                return toolRefusal('tool_blocked');
              if (
                !overrideCurrent(dispatch, target) ||
                currentConflicts.has(targetName)
              )
                return toolRefusal('tool_override_stale');
              if (
                !live?.enabled ||
                !approved(live) ||
                definitionHash(live) !== target.hash
              )
                throw new Error();
              if (
                confirmed &&
                (dispatch.revision !== state.revision ||
                  hashData(live.toolPolicies ?? {}) !== policyHash)
              )
                return toolRefusal('tool_approval_stale');
              if (toolPolicy(live, target.name) === 'ask' && !confirmed)
                return toolRefusal('tool_approval_required');
              signal.throwIfAborted();
              const result = await peer.client.callTool(
                {
                  name: target.name,
                  arguments: args,
                },
                undefined,
                { signal, timeout: 60000 },
              );
              const returned = await readState();
              if (!agentCanAccessConnector(returned, agentId, current.id))
                return toolRefusal('tool_scope_denied');
              if (agentToolSearchMode(returned, agentId) !== searchMode)
                return toolRefusal('tool_search_mode_changed');
              if (!overrideCurrent(returned, target))
                return toolRefusal('tool_override_stale');
              if (aliasClaimChanged(returned, targetName, target))
                return toolRefusal('tool_alias_conflict');
              peer.assertPublic(result);
              return result;
            },
          );
        } catch {
          // A queued call can be retired by a concurrent policy change before its
          // dispatch callback runs. Still report a live Block deterministically.
          try {
            const latest = await readState(),
              connector = latest.connectors.find(
                (item) => item.id === target.connectorId,
              );
            if (!agentCanAccessConnector(latest, agentId, target.connectorId))
              return toolRefusal('tool_scope_denied');
            if (agentToolSearchMode(latest, agentId) !== searchMode)
              return toolRefusal('tool_search_mode_changed');
            if (connector && toolPolicy(connector, target.name) === 'block')
              return toolRefusal('tool_blocked');
          } catch {
            /* Keep registry/provider diagnostics private. */
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'The connector is unavailable, changed, disabled, or requires authentication. Inspect the hub and refresh tools.',
              },
            ],
          };
        }
      });
      trace.finish({
        ...identity,
        status:
          refusals.get(result) ??
          ('isError' in result && result.isError ? 'error' : 'success'),
        resultSizeBytes: Buffer.byteLength(JSON.stringify(result)),
      });
      return result;
    } catch (error) {
      trace.finish({ ...identity, status: 'error', resultSizeBytes: 0 });
      throw error;
    }
  });
  return Object.assign(server, {
    requestLog,
    async refresh() {
      await sessions.reconcile(await readState());
      content.invalidate();
      await Promise.all([
        server.sendToolListChanged(),
        server.sendResourceListChanged(),
        server.sendPromptListChanged(),
      ]);
    },
  });
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
// Shared production execution boundary: no uncontained Playground fallback.
export function createManagedPeerFactory(
  directory: string,
  read: () => Promise<HubState>,
) {
  const storage = createPlatformCredentialStorage({
    directory: join(directory, 'credentials'),
  });
  const connect = async (
    connector: Connector,
    signal: AbortSignal,
  ): Promise<BridgePeer> => {
    let lease: SecretLease | undefined;
    let remoteCredentials:
      ReturnType<typeof createRemoteCredentials> | undefined;
    const client = new Client(
      { name: 'waleed-managed-agent', version: '0.1.0' },
      { capabilities: {} },
    );
    let docker: Awaited<ReturnType<typeof dockerAgentTransport>> | undefined;
    let remote: ReturnType<typeof safeMcpHttpTransport> | undefined;
    let native: ContainedStdioTransport | undefined;
    let closing: Promise<void> | undefined;
    const dispose = () =>
      (closing ??= (async () => {
        try {
          await remote?.terminateSession?.().catch(() => undefined);
          await client.close();
        } finally {
          try {
            await native?.close();
          } finally {
            try {
              await remote?.close();
            } finally {
              try {
                await docker?.dispose();
              } finally {
                lease?.dispose();
                await remoteCredentials?.dispose();
              }
            }
          }
        }
      })());
    try {
      // Installation is an explicit approved check, never background discovery.
      const packaged =
        connector.executionMode === 'package'
          ? await (
              await localPackageRuntime(directory)
            ).prepare(connector, signal)
          : connector.executionMode === 'native' && connector.bundle
            ? await createMcpbAdapter(directory, {
                node: process.execPath,
              }).prepare(connector)
            : undefined;
      const bound =
        Object.keys(connector.secretBindings).length ||
        Object.keys(connector.headerBindings).length;
      if (bound && connector.executionMode !== 'docker') {
        if (connector.executionMode !== 'remote')
          lease = await createBindingResolver(storage.backends, read)(
            connector,
            signal,
          );
      }
      if (connector.executionMode === 'docker') {
        docker = await dockerAgentTransport(
          connector,
          directory,
          signal,
          (backend) =>
            createBindingResolver({ docker: backend }, read)(connector, signal),
        );
        await client.connect(docker.transport, { timeout: 20000 });
      } else if (connector.executionMode === 'remote') {
        const backends = bound ? storage.backends : {};
        remoteCredentials = createRemoteCredentials(
          backends,
          read,
          connector,
          signal,
        );
        remote = safeMcpHttpTransport(
          connector.endpoint,
          connector.transport,
          signal,
          undefined,
          remoteCredentials.headers,
          connector.localHttpOptIn === true,
        );
        await client.connect(remote, { timeout: 20000 });
      } else if (
        connector.executionMode === 'native' ||
        connector.executionMode === 'package'
      ) {
        const executable =
          packaged?.executable ??
          (connector.executionMode === 'native' ? connector.executable : '');
        const runner = await createPlatformProcessRunner({
          allowedExecutables: [executable],
          workingDirectory: packaged?.workingDirectory ?? directory,
          concurrency: 1,
        });
        native = new ContainedStdioTransport(
          runner,
          {
            executable,
            arguments:
              packaged?.arguments ??
              (connector.executionMode === 'native'
                ? isolatedNativeArguments(connector)
                : []),
            environment: {
              ...packaged?.environment,
              ...connector.environmentLiterals,
              ...lease?.environment,
            },
            timeoutMs: bridgeSessionLimits.maxLifetimeMs,
            session: true,
            outputLimitBytes: 1024 * 1024,
          },
          signal,
        );
        await client.connect(native, { timeout: 20000 });
      }
      return {
        client,
        ...(connector.executionMode !== 'remote' &&
        lease?.expiresAt !== undefined
          ? { expiresAt: lease.expiresAt }
          : {}),
        dispose,
        assertPublic(value) {
          assertNoCredentialEcho(value, [
            ...Object.values(lease?.environment ?? {}),
            ...Object.values(lease?.headers ?? {}),
            ...(remoteCredentials?.values() ?? []),
          ]);
        },
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  };
  return connect;
}
export async function runAgentBridge(registry: string, agentId: string) {
  const targetAgentId = IntegrationAgentIdSchema.parse(agentId);
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
  await read();
  const sender = createRequestLogSender(directory);
  const server = createAgentBridge(
    read,
    createManagedPeerFactory(directory, read),
    targetAgentId,
    {},
    createRequestLog({ onRecord: (record) => sender.send(record) }),
  );
  const changed = () => {
    void server.refresh().catch(() => undefined);
  };
  const safety = join(directory, 'safety.json');
  const cleanup = () => {
    unwatchFile(registry, changed);
    unwatchFile(safety, changed);
    process.stdin.removeListener('end', close);
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
  };
  const shutdown = server.close.bind(server);
  server.close = async () => {
    cleanup();
    await shutdown();
    await sender.close();
  };
  const close = () => {
    void server.close().catch(() => undefined);
  };
  await server.connect(new StdioServerTransport());
  watchFile(registry, { interval: 1000, persistent: false }, changed);
  watchFile(safety, { interval: 1000, persistent: false }, changed);
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
