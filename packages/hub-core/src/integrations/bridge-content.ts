import { randomUUID } from 'node:crypto';
import type { Connector, HubState, HttpClientAgentId } from '@waleed/contracts';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  PromptSchema,
  McpError,
  ErrorCode,
  type Resource,
  type ResourceTemplate,
  type Prompt,
  type GetPromptResult,
  type ReadResourceResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListPromptsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { approved, hashData } from '../runtime/registry.js';
import { agentCanAccessConnector } from './agent-profiles.js';
import {
  peerSessionFingerprint,
  type createPeerSessions,
} from './peer-sessions.js';
import type { BridgePeer } from './bridge.js';

const limits = {
  items: 256,
  routes: 4096,
  pages: 8,
  metadataBytes: 1024 * 1024,
  uriLength: 4096,
};
type Kind = 'resources' | 'templates' | 'prompts';
type Route = {
  kind: Kind;
  connectorId: string;
  grant: string;
  upstream: string;
  handle: string;
  variables?: string[];
  template?: UriTemplate;
};
const trustedRefusals = new WeakSet<object>();
const denied = () => {
  const error = new McpError(
    ErrorCode.InvalidParams,
    'The Hub resource or prompt handle is unknown, stale, or outside the current tool set. Refresh its catalog.',
  );
  trustedRefusals.add(error);
  return error;
};
const unavailable = () =>
  new McpError(
    ErrorCode.InternalError,
    'The Hub resource or prompt is unavailable or its content was withheld. Refresh approval, credentials and catalogs.',
  );
const hasControls = (value: string, spaces = false) =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < (spaces ? 33 : 32) ||
      character.charCodeAt(0) === 127,
  );
const validString = (value: string) =>
  value.length > 0 &&
  value.length <= limits.uriLength &&
  !hasControls(value, true);

export function createBridgeContent(
  server: Server,
  read: () => Promise<HubState>,
  sessions: ReturnType<typeof createPeerSessions>,
  admitted: <T>(action: () => Promise<T>) => Promise<T>,
  agentId?: HttpClientAgentId,
) {
  // Only routing metadata is retained. Never cache resource bodies, prompt
  // messages, arguments, provider errors, or credential leases here.
  const routes = new Map<string, Route>(),
    keys = new Map<string, string>();
  const current: Record<Kind, Set<string>> = {
    resources: new Set(),
    templates: new Set(),
    prompts: new Set(),
  };
  const generations: Record<Kind, number> = {
    resources: 0,
    templates: 0,
    prompts: 0,
  };
  const attached = new WeakSet<BridgePeer>(),
    notices = new Set<string>();
  let closed = false;
  const grant = (connector: Connector, state: HubState) =>
    peerSessionFingerprint(connector, state, agentId);
  const authorized = (
    route: Pick<Route, 'connectorId' | 'grant'>,
    state: HubState,
  ) => {
    const connector = state.connectors.find(
      (item) => item.id === route.connectorId,
    );
    if (!connector || grant(connector, state) !== route.grant) throw denied();
    return connector;
  };
  const invalidate = (kind: Kind, connectorId?: string) => {
    generations[kind]++;
    for (const handle of current[kind])
      if (!connectorId || routes.get(handle)?.connectorId === connectorId)
        current[kind].delete(handle);
  };
  const watch = (peer: BridgePeer, connector: Connector, state: HubState) => {
    if (attached.has(peer)) return;
    attached.add(peer);
    const target = {
      connectorId: connector.id,
      grant: grant(connector, state),
    };
    const notify = async (kind: 'resources' | 'prompts') => {
      const key = `${connector.id}:${kind}`;
      if (closed || notices.has(key)) return;
      notices.add(key);
      try {
        const latest = await read();
        if (
          closed ||
          !peer.client.transport ||
          (peer.expiresAt !== undefined && peer.expiresAt <= Date.now())
        )
          return;
        authorized(target, latest);
        invalidate(kind, connector.id);
        if (kind === 'resources') invalidate('templates', connector.id);
        // Never relay provider notification parameters, URIs or diagnostics.
        if (kind === 'resources') await server.sendResourceListChanged();
        else await server.sendPromptListChanged();
      } catch {
        /* Stale/out-of-scope peers cannot emit agent-visible notices. */
      } finally {
        notices.delete(key);
      }
    };
    peer.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      () => notify('resources'),
    );
    peer.client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      () => notify('prompts'),
    );
  };
  const remember = (
    kind: Kind,
    connector: Connector,
    state: HubState,
    upstream: string,
  ) => {
    if (
      kind === 'prompts'
        ? !upstream.length || upstream.length > 256 || hasControls(upstream)
        : !validString(upstream)
    )
      throw denied();
    const fingerprint = grant(connector, state),
      key = hashData([kind, connector.id, fingerprint, upstream]);
    const previous = keys.get(key);
    if (previous) return routes.get(previous)!;
    if (routes.size >= limits.routes) throw unavailable();
    const id = randomUUID();
    const route: Route = {
      kind,
      connectorId: connector.id,
      grant: fingerprint,
      upstream,
      handle: `wmh-resource://r-${id}`,
    };
    if (kind === 'templates') {
      // Expose a query-variable wrapper, not secret-bearing upstream URI
      // literals. Expand the original URI only inside the owning managed peer.
      if (
        upstream.length > 2048 ||
        (upstream.match(/\{/g)?.length ?? 0) > 16 ||
        /\{[^}]*[:*]/u.test(upstream)
      )
        throw denied();
      const template = new UriTemplate(upstream),
        variables = [...new Set(template.variableNames)];
      if (
        variables.length > 16 ||
        variables.some(
          (name) =>
            !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ||
            ['constructor', 'prototype', '__proto__'].includes(name),
        )
      )
        throw denied();
      route.handle = `wmh-resource://t-${id}/`;
      route.template = template;
      route.variables = variables;
    } else if (kind === 'prompts') {
      const slug = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
      route.handle = `${slug(connector.name).slice(0, 16)}__${slug(upstream).slice(0, 9)}_${id.replaceAll('-', '').slice(0, 10)}`;
    }
    if (routes.has(route.handle)) throw unavailable(); // Never retarget a collision.
    routes.set(route.handle, route);
    keys.set(key, route.handle);
    return route;
  };
  const publicResource = (
    resource: Resource,
    connector: Connector,
    state: HubState,
  ) => {
    const route = remember('resources', connector, state, resource.uri);
    return { route, value: { ...resource, uri: route.handle } };
  };
  const run = async <T>(action: () => Promise<T>) =>
    admitted(async () => {
      try {
        if (closed) throw unavailable();
        return await action();
      } catch (error) {
        if (error && typeof error === 'object' && trustedRefusals.has(error))
          throw error;
        throw unavailable();
      }
    });
  const discover = async (
    kind: Kind,
    cursor: string | undefined,
    requestSignal: AbortSignal,
  ) => {
    if (cursor !== undefined) throw denied(); // Hub cursors are never upstream cursors.
    const version = ++generations[kind],
      signal = AbortSignal.any([requestSignal, AbortSignal.timeout(45000)]);
    const state = await read();
    await sessions.reconcile(state);
    const output: Array<{
      route: Route;
      value: Resource | ResourceTemplate | Prompt;
    }> = [];
    let bytes = 0,
      truncated = false;
    for (const connector of state.connectors.filter(
      (item) =>
        item.enabled &&
        approved(item) &&
        agentCanAccessConnector(state, agentId, item.id),
    )) {
      if (
        signal.aborted ||
        output.length >= limits.items ||
        bytes > limits.metadataBytes
      ) {
        truncated = true;
        break;
      }
      try {
        await sessions.use(
          connector,
          state,
          AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          async (peer, signal) => {
            watch(peer, connector, state);
            const capabilities = peer.client.getServerCapabilities();
            if (
              kind === 'prompts'
                ? !capabilities?.prompts
                : !capabilities?.resources
            )
              return;
            let next: string | undefined;
            const seen = new Set<string>();
            for (let page = 0; page < limits.pages; page++) {
              const params = next ? { cursor: next } : {};
              const result =
                kind === 'resources'
                  ? await peer.client.listResources(params, {
                      signal,
                      timeout: 20000,
                    })
                  : kind === 'templates'
                    ? await peer.client.listResourceTemplates(params, {
                        signal,
                        timeout: 20000,
                      })
                    : await peer.client.listPrompts(params, {
                        signal,
                        timeout: 20000,
                      });
              peer.assertPublic(result);
              const entries =
                kind === 'resources'
                  ? (result as ListResourcesResult).resources
                  : kind === 'templates'
                    ? (result as ListResourceTemplatesResult).resourceTemplates
                    : (result as ListPromptsResult).prompts;
              for (const raw of entries) {
                bytes += Buffer.byteLength(JSON.stringify(raw));
                if (
                  output.length >= limits.items ||
                  bytes > limits.metadataBytes
                ) {
                  truncated = true;
                  break;
                }
                try {
                  let route: Route, value: Resource | ResourceTemplate | Prompt;
                  if (kind === 'resources') {
                    const projected = publicResource(
                      ResourceSchema.parse(raw),
                      connector,
                      state,
                    );
                    route = projected.route;
                    value = projected.value;
                  } else if (kind === 'templates') {
                    const template = ResourceTemplateSchema.parse(raw);
                    route = remember(
                      kind,
                      connector,
                      state,
                      template.uriTemplate,
                    );
                    value = {
                      ...template,
                      uriTemplate:
                        route.handle +
                        (route.variables?.length
                          ? `{?${route.variables.join(',')}}`
                          : ''),
                    };
                  } else {
                    const prompt = PromptSchema.parse(raw);
                    route = remember(kind, connector, state, prompt.name);
                    value = { ...prompt, name: route.handle };
                  }
                  if (
                    !output.some((item) => item.route.handle === route.handle)
                  )
                    output.push({ route, value });
                } catch {
                  truncated = true; /* Invalid/unroutable metadata is omitted. */
                }
              }
              next = result.nextCursor;
              if (
                !next ||
                output.length >= limits.items ||
                bytes > limits.metadataBytes
              )
                break;
              if (seen.has(next) || page === limits.pages - 1) {
                truncated = true;
                break;
              }
              seen.add(next);
            }
          },
        );
      } catch {
        truncated = true; /* Unsupported/unavailable peers are isolated. */
      }
    }
    const latest = await read();
    await sessions.reconcile(latest);
    if (closed || version !== generations[kind] || signal.aborted) {
      truncated = true;
      return { values: [], truncated };
    }
    const visible = output.filter((item) => {
      try {
        authorized(item.route, latest);
        return true;
      } catch {
        return false;
      }
    });
    current[kind] = new Set(visible.map((item) => item.route.handle));
    return { values: visible.map((item) => item.value), truncated };
  };
  const resolveResource = (uri: string) => {
    if (!validString(uri)) throw denied();
    const direct = routes.get(uri);
    if (direct?.kind === 'resources' && current.resources.has(uri))
      return { route: direct, upstream: direct.upstream };
    const url = new URL(uri),
      base = `${url.protocol}//${url.host}${url.pathname}`,
      route = routes.get(base);
    if (
      !route ||
      route.kind !== 'templates' ||
      !current.templates.has(base) ||
      url.hash ||
      url.username ||
      url.password ||
      url.port ||
      `${base}${url.search}` !== uri
    )
      throw denied();
    const variables: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [key, value] of url.searchParams) {
      if (!route.variables?.includes(key) || Object.hasOwn(variables, key))
        throw denied();
      variables[key] = value;
    }
    const upstream = route.template!.expand(variables);
    if (!validString(upstream)) throw denied();
    return { route, upstream };
  };
  const assertContent = (peer: BridgePeer, result: unknown) => {
    peer.assertPublic(result);
    // Binary resources and image/audio prompt blocks may hide a known credential
    // inside base64 with an arbitrary prefix/alignment. Check decoded bytes too.
    const visit = (value: unknown, depth = 0) => {
      if (depth > 64) throw unavailable();
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'blob' || key === 'data') && typeof item === 'string') {
          const bytes = Buffer.from(item, 'base64');
          try {
            peer.assertPublic({ text: bytes.toString('utf8') });
          } finally {
            bytes.fill(0);
          }
        } else visit(item, depth + 1);
      }
    };
    visit(result);
  };
  const useRoute = async <T>(
    route: Route,
    requestSignal: AbortSignal,
    action: (
      peer: BridgePeer,
      signal: AbortSignal,
      connector: Connector,
      state: HubState,
    ) => Promise<T>,
  ) => {
    const state = await read();
    await sessions.reconcile(state);
    const connector = authorized(route, state);
    return sessions.use(
      connector,
      state,
      AbortSignal.any([requestSignal, AbortSignal.timeout(60000)]),
      async (peer, signal) => {
        const dispatch = await read(),
          live = authorized(route, dispatch);
        watch(peer, live, dispatch);
        if (!current[route.kind].has(route.handle)) throw denied();
        signal.throwIfAborted();
        const result = await action(peer, signal, live, dispatch);
        peer.assertPublic(result);
        const returned = await read();
        authorized(route, returned);
        signal.throwIfAborted();
        if (!current[route.kind].has(route.handle)) throw denied();
        return result;
      },
    );
  };
  server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
    run(async () => {
      const result = await discover(
        'resources',
        request.params?.cursor,
        extra.signal,
      );
      return {
        resources: result.values as Resource[],
        _meta: { 'wmh/truncated': result.truncated },
      };
    }),
  );
  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    (request, extra) =>
      run(async () => {
        const result = await discover(
          'templates',
          request.params?.cursor,
          extra.signal,
        );
        return {
          resourceTemplates: result.values as ResourceTemplate[],
          _meta: { 'wmh/truncated': result.truncated },
        };
      }),
  );
  server.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
    run(async () => {
      const result = await discover(
        'prompts',
        request.params?.cursor,
        extra.signal,
      );
      return {
        prompts: result.values as Prompt[],
        _meta: { 'wmh/truncated': result.truncated },
      };
    }),
  );
  server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
    run(async () => {
      const { route, upstream } = resolveResource(request.params.uri);
      return useRoute(
        route,
        extra.signal,
        async (peer, signal, connector, state): Promise<ReadResourceResult> => {
          const result = await peer.client.readResource(
            { uri: upstream },
            { signal, timeout: 60000 },
          );
          assertContent(peer, result);
          return {
            ...result,
            contents: result.contents.map((content) => {
              if (content.uri === upstream)
                return { ...content, uri: request.params.uri };
              const projected = remember(
                'resources',
                connector,
                state,
                content.uri,
              );
              current.resources.add(projected.handle);
              return { ...content, uri: projected.handle };
            }),
          };
        },
      );
    }),
  );
  server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
    run(async () => {
      const route = routes.get(request.params.name);
      if (
        !route ||
        route.kind !== 'prompts' ||
        !current.prompts.has(route.handle)
      )
        throw denied();
      const args = structuredClone(request.params.arguments);
      if (Buffer.byteLength(JSON.stringify(args ?? {})) > 48 * 1024)
        throw denied();
      return useRoute(
        route,
        extra.signal,
        async (peer, signal, connector, state): Promise<GetPromptResult> => {
          const result = await peer.client.getPrompt(
            { name: route.upstream, ...(args ? { arguments: args } : {}) },
            { signal, timeout: 60000 },
          );
          assertContent(peer, result);
          return {
            ...result,
            messages: result.messages.map((message) => {
              const content = message.content;
              if (
                content.type === 'resource' ||
                content.type === 'resource_link'
              ) {
                const source =
                  content.type === 'resource' ? content.resource : content;
                const resource = remember(
                  'resources',
                  connector,
                  state,
                  source.uri,
                );
                current.resources.add(resource.handle);
                return {
                  ...message,
                  content:
                    content.type === 'resource'
                      ? {
                          ...content,
                          resource: {
                            ...content.resource,
                            uri: resource.handle,
                          },
                        }
                      : { ...content, uri: resource.handle },
                };
              }
              return message;
            }),
          };
        },
      );
    }),
  );
  const unsupported = () => {
    throw new McpError(
      ErrorCode.MethodNotFound,
      'Hub resource subscriptions are not supported.',
    );
  };
  server.setRequestHandler(SubscribeRequestSchema, unsupported);
  server.setRequestHandler(UnsubscribeRequestSchema, unsupported);
  return {
    invalidate() {
      invalidate('resources');
      invalidate('templates');
      invalidate('prompts');
    },
    close() {
      closed = true;
      routes.clear();
      keys.clear();
      current.resources.clear();
      current.templates.clear();
      current.prompts.clear();
    },
  };
}
