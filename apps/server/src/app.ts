import Fastify from 'fastify';
import type { Socket } from 'node:net';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import {
  MAX_REQUEST_BYTES,
  MCPB_MAX_ARCHIVE_BYTES,
  SessionRequestSchema,
  ApplyRequestSchema,
  IdSchema,
  ToolPoliciesUpdateSchema,
  BootstrapSchema,
  AgentIdSchema,
  RefusalReasonSchema,
  type RefusalInput,
  ImportSavePreviewRequestSchema,
  SecretDeleteSchema,
  IntegrationAgentIdSchema,
  AgentProfileUpdateSchema,
  AgentToolSearchUpdateSchema,
  PlaygroundCatalogRequestSchema,
  PlaygroundInvokeRequestSchema,
  HealthRetestRequestSchema,
  ToolOverrideUpdateSchema,
  SETUP_MAX_BYTES,
  CredentialStorageStatusSchema,
} from '@waleed/contracts';
import {
  HubError,
  publicError,
  definitionHash,
  profileHash,
  type HubLifecycle,
  type DiscoveryService,
  addManualMcp,
  createRegistryClient,
} from '@waleed/hub-core';
import { createSessions } from './security.js';
import { registerHttpMcp } from './http-mcp.js';

export interface ServerOptions {
  lifecyclePreferencesChanged?: (
    value: import('@waleed/contracts').LifecyclePreferences,
  ) => void;
  port: number;
  lifecycle: HubLifecycle;
  discovery?: DiscoveryService;
  webRoot?: string;
  now?: () => number;
  shutdown?: () => void;
  registry?: ReturnType<typeof createRegistryClient>;
}

export async function createHubServer(options: ServerOptions) {
  const origin = `http://127.0.0.1:${options.port}`;
  const host = `127.0.0.1:${options.port}`;
  const sessions = createSessions(options.now);
  const imports = options.lifecycle.adoption.imports;
  const registry = options.registry ?? createRegistryClient();
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_REQUEST_BYTES,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    trustProxy: false,
    routerOptions: { maxParamLength: 100 },
  });
  // Node's HTTP close drains accepted requests but can wait for a browser's
  // speculative TCP connection that has never produced a request. Retire only
  // those sockets; do not interrupt in-flight mutations to release writer locks.
  const unstarted = new Set<Socket>();
  let draining = false;
  app.server.on('connection', (socket) => {
    if (draining) {
      socket.destroy();
      return;
    }
    unstarted.add(socket);
    socket.once('close', () => unstarted.delete(socket));
  });
  app.server.on('request', (request, response) => {
    unstarted.delete(request.socket);
    response.once('finish', () => {
      // A request already active when close began can become keep-alive idle
      // after Node's initial idle sweep. Reap it only after response completion.
      if (draining) app.server.closeIdleConnections();
    });
  });
  app.addHook('preClose', async () => {
    draining = true;
    for (const socket of unstarted) socket.destroy();
    unstarted.clear();
  });
  await app.register(cookie);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  const routes: Record<string, RefusalInput['route']> = {
    '/api/credential-storage': 'credential_storage',
    '/api/credential-storage/check': 'credential_storage',
    '/mcp': 'http_mcp',
    '/api/http-tokens': 'http_tokens',
    '/api/http-tokens/:id': 'http_tokens',
    '/api/settings/onboarding': 'onboarding',
    '/api/setup/export': 'setup_export',
    '/api/setup/import/preview': 'setup_import',
    '/api/setup/import/apply': 'setup_import',
    '/api/setup/import/:id/cancel': 'setup_import',
    '/api/connectors/:id/tool-override': 'tool_override',
    '/api/health/connectors': 'connector_health',
    '/api/health/retest': 'connector_health',
    '/api/lifecycle/startup': 'lifecycle_startup',
    '/api/lifecycle/preferences': 'lifecycle_preferences',
    '/api/request-log': 'request_log',
    '/api/playground/catalog': 'playground_catalog',
    '/api/playground/invoke': 'playground_invoke',
    '/api/playground/jobs/:id': 'playground_job',
    '/api/playground/jobs/:id/cancel': 'playground_cancel',
    '/health': 'health',
    '/api/session': 'session',
    '/api/session/logout': 'logout',
    '/api/bootstrap': 'bootstrap',
    '/api/connectors': 'connectors',
    '/api/profiles': 'profiles',
    '/api/agents': 'agents',
    '/api/activity': 'activity',
    '/api/settings': 'settings',
    '/api/operations/preview': 'preview',
    '/api/operations/apply': 'apply',
    '/api/jobs/:id': 'job',
    '/api/jobs/:id/cancel': 'cancel',
    '/api/security-activity': 'security_activity',
    '/api/recovery': 'recovery',
    '/api/discovery': 'discovery',
    '/api/discovery/jobs/:id': 'discovery_job',
    '/api/discovery/jobs/:id/cancel': 'discovery_cancel',
    '/api/adoption/preview': 'adoption_preview',
    '/api/imports/preview': 'import_preview',
    '/api/bundles/preview': 'import_preview',
    '/api/bundles/:id/install': 'import_save_preview',
    '/api/bundles/:id/cancel': 'import_cancel',
    '/api/imports/:id': 'import_read',
    '/api/imports/:id/selection': 'import_selection',
    '/api/imports/:id/cancel': 'import_cancel',
    '/api/imports/:id/save-preview': 'import_save_preview',
    '/api/imports/:id/apply': 'import_save_preview',
    '/api/adoption/agents/:agentId/preview': 'adoption_preview',
    '/api/registry/servers': 'discovery',
    '/api/connectors/:id/check': 'connector_check',
    '/api/connectors/:id/tool-policies': 'tool_policies',
    '/api/runtime/jobs/:id': 'runtime_job',
    '/api/runtime/jobs/:id/cancel': 'runtime_cancel',
    '/api/connectors/:id/credentials': 'credential_write',
    '/api/credentials': 'auth_status',
    '/api/credentials/:id/delete': 'credential_delete',
    '/api/connectors/:id/auth': 'auth_status',
    '/api/connectors/:id/oauth': 'oauth_start',
    '/api/connectors/:id/oauth/refresh': 'oauth_refresh',
    '/api/connectors/:id/oauth/discover': 'oauth_start',
    '/api/connectors/:id/oauth/disconnect': 'credential_delete',
    '/api/oauth/accounts': 'auth_status',
    '/api/auth/jobs/:id': 'auth_job',
    '/api/auth/jobs/:id/cancel': 'auth_cancel',
    '/api/agents/scan': 'agent_scan',
    '/api/agents/:agentId/integrate': 'agent_integrate',
    '/api/agents/:agentId/disconnect': 'agent_disconnect',
    '/api/agents/:agentId/status': 'agent_status',
    '/api/agents/tool-sets': 'agent_tool_sets',
    '/api/agents/:agentId/profile': 'agent_profile',
    '/api/agents/:agentId/tool-search': 'agent_tool_search',
    '/api/agents/sync': 'agent_sync',
    '/api/connectors/manual': 'manual_mcp',
    '/api/desktop/shutdown': 'desktop_shutdown',
  };
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    let reason: RefusalInput['reason'] = 'invalid_request';
    // Inspect only a small server-generated response code. Never retain or copy
    // request bodies, cookies, headers, query strings, paths, or session IDs.
    if (typeof payload === 'string' && payload.length < 2048) {
      try {
        const parsed = RefusalReasonSchema.safeParse(
          (JSON.parse(payload) as { error?: unknown }).error,
        );
        if (parsed.success) reason = parsed.data;
      } catch {
        /* Non-JSON error bodies still get structural metadata only. */
      }
    }
    const method = ['GET', 'HEAD', 'POST'].includes(request.method)
      ? (request.method as RefusalInput['method'])
      : 'OTHER';
    const route = Object.hasOwn(routes, request.routeOptions.url ?? '')
      ? routes[request.routeOptions.url!]!
      : request.routeOptions.config.public === true
        ? 'assets'
        : 'unknown';
    try {
      await options.lifecycle.safety.recordRefusal({
        reason,
        method,
        route,
        status: reply.statusCode,
      });
    } catch {
      // A bounded/full queue or failed disk write must not silently masquerade
      // as successful auditing. Returning a payload avoids recursive error hooks.
      reply.code(503);
      reply.removeHeader('content-length');
      reply.type('application/json');
      return JSON.stringify({
        error: 'audit_unavailable',
        message:
          'Security audit storage is unavailable. Inspect the runtime before retrying.',
      });
    }
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (request.headers.host !== host)
      return reply.code(403).send({
        error: 'host_denied',
        message: 'Use the exact loopback launch address.',
      });
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== origin
    )
      return reply.code(403).send({
        error: 'origin_denied',
        message: 'Foreign origins are not allowed.',
      });
    if (request.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({
        error: 'origin_denied',
        message: 'Cross-site requests are not allowed.',
      });
    // Only these registered MCP methods use Bearer auth. Host/Origin checks above
    // still apply; browser APIs keep their unchanged session/Origin/CSRF rules.
    if (request.routeOptions.config.mcpBearer === true) return;
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation && request.headers.origin !== origin)
      return reply.code(403).send({
        error: 'origin_required',
        message: 'Mutations require the local browser origin.',
      });

    // Route metadata prevents path-encoding/trailing-slash tricks from bypassing auth.
    const publicRoute = request.routeOptions.config.public === true;
    if (!publicRoute) {
      const id = request.cookies.waleed_hub_session;
      if (!sessions.get(id))
        return reply.code(401).send({
          error: 'session_required',
          message: 'Start the hub to open a new local session.',
        });
      if (
        mutation &&
        !sessions.verifyCsrf(
          id!,
          typeof request.headers['x-csrf-token'] === 'string'
            ? request.headers['x-csrf-token']
            : '',
        )
      ) {
        return reply.code(403).send({
          error: 'csrf_required',
          message: 'Refresh this session before trying again.',
        });
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HubError) {
      const safe = publicError(error);
      const statuses = {
        conflict: 409,
        unavailable: 503,
        invalid: 400,
        not_found: 404,
        busy: 409,
      };
      const status = safe.code === 'internal_error' ? 500 : statuses[safe.code];
      return reply
        .code(status)
        .send({ error: safe.code, message: safe.message });
    }
    // Never reflect validation errors (which may contain pasted values), paths,
    // request bodies, exception messages, or provider output back into diagnostics.
    if (error instanceof Error && error.name === 'ZodError')
      return reply.code(400).send({
        error: 'invalid_input',
        message: 'Input does not match the supported schema or limits.',
      });
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({
        error: 'invalid_request',
        message: 'Request rejected. Check its format and size.',
      });
    }
    return reply.code(500).send({
      error: 'internal_error',
      message:
        'The operation failed. Inspect recovery before retrying; external state may require review.',
    });
  });
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({
      error: 'not_found',
      message: 'This route is not available in the foundation build.',
    }),
  );

  app.get('/health', { config: { public: true } }, async () => ({
    ready: true,
  }));
  registerHttpMcp(app, options.lifecycle, options.now);
  app.get('/api/credential-storage', async () =>
    CredentialStorageStatusSchema.parse(
      options.lifecycle.credentialStorage.status(),
    ),
  );
  app.post('/api/credential-storage/check', async () =>
    CredentialStorageStatusSchema.parse(
      await options.lifecycle.credentialStorage.check(),
    ),
  );
  app.get('/api/request-log', async () =>
    options.lifecycle.requestLogSnapshot(),
  );
  app.post('/api/playground/catalog', async (request) =>
    options.lifecycle.playground.catalog(
      PlaygroundCatalogRequestSchema.parse(request.body),
    ),
  );
  app.post('/api/playground/invoke', async (request) =>
    options.lifecycle.playground.invoke(
      PlaygroundInvokeRequestSchema.parse(request.body),
      request.cookies.waleed_hub_session!,
    ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/playground/jobs/:id',
    async (request) =>
      options.lifecycle.playground.job(
        request.params.id,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/playground/jobs/:id/cancel',
    async (request) =>
      options.lifecycle.playground.cancel(
        request.params.id,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post(
    '/api/session',
    { config: { public: true } },
    async (request, reply) => {
      const { token } = SessionRequestSchema.parse(request.body);
      const session = sessions.consume(token);
      if (!session)
        return reply.code(401).send({
          error: 'launch_expired',
          message:
            'Launch link expired or was already used. Restart the hub for a fresh link.',
        });
      reply.setCookie('waleed_hub_session', session.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 8 * 60 * 60,
      });
      // Secure is intentionally omitted on this exact HTTP loopback-only origin.
      return { csrfToken: session.csrf };
    },
  );
  app.get('/api/session', async (request) => ({
    csrfToken: sessions.get(request.cookies.waleed_hub_session)!.csrf,
  }));
  app.post('/api/session/logout', async (request, reply) => {
    options.lifecycle.auth.revokeSession(request.cookies.waleed_hub_session!);
    imports.revoke(request.cookies.waleed_hub_session!);
    options.lifecycle.bundles.revoke(request.cookies.waleed_hub_session!);
    options.lifecycle.setup.revoke(request.cookies.waleed_hub_session!);
    options.lifecycle.playground.revoke(request.cookies.waleed_hub_session!);
    sessions.revoke(request.cookies.waleed_hub_session!);
    reply.clearCookie('waleed_hub_session', { path: '/' });
    return { signedOut: true };
  });
  app.get('/api/bootstrap', async () =>
    BootstrapSchema.parse({
      stage: options.discovery ? 'discovery' : 'foundation',
      revision: (await options.lifecycle.inventory()).revision,
      runtime: { node: process.versions.node, platform: process.platform },
      capabilities: {
        localProfiles: true,
        importPreview: true,
        discovery: !!options.discovery,
        connectorManagement: true,
        runtimeChecks: options.lifecycle.capabilities.runtimeChecks,
        materialization: options.lifecycle.capabilities.materialization,
        secrets: options.lifecycle.capabilities.secrets,
        agentApply: options.lifecycle.capabilities.agentApply,
        playground: options.lifecycle.capabilities.playground,
        desktop: !!options.shutdown,
        startup: options.lifecycle.capabilities.startup,
      },
      docker: options.discovery?.snapshot().docker.state ?? 'not_checked',
    }),
  );
  app.get('/api/connectors', async () => {
    const state = await options.lifecycle.inventory();
    return {
      connectors: state.connectors.map((connector) => ({
        ...connector,
        executionHash: definitionHash(connector),
        toolOverrides: (state.toolOverrides ?? []).filter(
          (item) => item.connectorId === connector.id,
        ),
      })),
      observations: await options.lifecycle.checks.observations(),
    };
  });
  app.get('/api/health/connectors', async () =>
    options.lifecycle.health.snapshot(),
  );
  app.post('/api/health/retest', async (request) =>
    options.lifecycle.health.retest(
      HealthRetestRequestSchema.parse(request.body),
    ),
  );
  app.get('/api/lifecycle/startup', async () =>
    options.lifecycle.settings.startup(),
  );
  app.post('/api/lifecycle/startup', async (request) =>
    options.lifecycle.settings.setStartup(request.body),
  );
  app.get('/api/lifecycle/preferences', async () =>
    options.lifecycle.settings.preferences(),
  );
  app.get('/api/settings/onboarding', async () =>
    options.lifecycle.settings.onboarding(),
  );
  app.post('/api/settings/onboarding', async (request) =>
    options.lifecycle.settings.setOnboarding(request.body),
  );
  app.post('/api/lifecycle/preferences', async (request) => {
    const value = await options.lifecycle.settings.update(request.body);
    options.lifecyclePreferencesChanged?.(value);
    return value;
  });
  app.get('/api/profiles', async () => {
    const state = await options.lifecycle.inventory();
    return {
      profiles: state.profiles,
      revision: state.revision,
      materializations: (state.materializations ?? []).map((record) => {
        const profile = state.profiles.find(
          (profile) => profile.id === record.profileId,
        );
        return {
          ...record,
          stale:
            !profile ||
            record.configurationHash !== profileHash(profile, state),
        };
      }),
      bindings: state.agentBindings ?? [],
    };
  });
  app.get('/api/agents', async () => ({
    ...(options.discovery
      ? { agents: options.discovery.snapshot().agents }
      : {
          agents: AgentIdSchema.options.map((agentId) => ({
            agentId,
            executable: null,
            version: null,
            detected: null,
            compatibility: 'pending',
            registered: null,
            reconnectRequired: null,
            checkedAt: null,
          })),
        }),
  }));
  app.get('/api/agents/tool-sets', async () =>
    options.lifecycle.integrations.toolSets(
      await options.lifecycle.checks.observations(),
    ),
  );
  app.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/tool-search',
    async (request) => {
      const input = AgentToolSearchUpdateSchema.parse(request.body),
        agentId = IntegrationAgentIdSchema.parse(request.params.agentId),
        owner = request.cookies.waleed_hub_session!;
      const preview = await options.lifecycle.preview(
          { ...input, agentId, kind: 'set_agent_tool_search' },
          owner,
        ),
        job = await options.lifecycle.apply(preview.id, owner);
      let result = options.lifecycle.job(job.id, owner);
      while (result.state === 'queued' || result.state === 'running') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        result = options.lifecycle.job(job.id, owner);
      }
      if (result.state !== 'succeeded')
        throw new HubError(
          'conflict',
          'Tool search mode was not confirmed. Refresh tool sets and inspect recovery before retrying.',
        );
      return { state: 'saved', recoveryRequired: !!result.reason };
    },
  );
  app.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/profile',
    async (request) => {
      const input = AgentProfileUpdateSchema.parse(request.body),
        agentId = IntegrationAgentIdSchema.parse(request.params.agentId),
        owner = request.cookies.waleed_hub_session!;
      const preview = await options.lifecycle.preview(
          { ...input, agentId, kind: 'set_agent_profile' },
          owner,
        ),
        job = await options.lifecycle.apply(preview.id, owner);
      let result = options.lifecycle.job(job.id, owner);
      while (result.state === 'queued' || result.state === 'running') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        result = options.lifecycle.job(job.id, owner);
      }
      if (result.state !== 'succeeded')
        throw new HubError(
          'conflict',
          'Agent tool set was not confirmed. Refresh inventory and inspect recovery before retrying.',
        );
      return { state: 'saved', recoveryRequired: !!result.reason };
    },
  );
  app.get('/api/discovery', async () => {
    if (!options.discovery)
      throw new HubError(
        'unavailable',
        'Discovery is not available in this runtime.',
      );
    return options.discovery.snapshot();
  });
  app.post('/api/discovery', async (request, reply) => {
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    )
      throw new HubError(
        'invalid',
        'Discovery accepts no executable, path, arguments, or environment input.',
      );
    if (!options.discovery)
      throw new HubError(
        'unavailable',
        'Discovery is not available in this runtime.',
      );
    return reply
      .code(202)
      .send(options.discovery.start(request.cookies.waleed_hub_session!));
  });
  app.get<{ Params: { id: string } }>(
    '/api/discovery/jobs/:id',
    async (request) => {
      if (!options.discovery)
        throw new HubError('unavailable', 'Discovery is unavailable.');
      return options.discovery.job(
        IdSchema.parse(request.params.id),
        request.cookies.waleed_hub_session!,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/discovery/jobs/:id/cancel',
    async (request) => {
      if (!options.discovery)
        throw new HubError('unavailable', 'Discovery is unavailable.');
      return options.discovery.cancel(
        IdSchema.parse(request.params.id),
        request.cookies.waleed_hub_session!,
      );
    },
  );
  app.get('/api/adoption/preview', async () => {
    if (!options.discovery)
      throw new HubError('unavailable', 'Discovery is unavailable.');
    const records = await options.lifecycle.safety.read();
    return options.discovery.preview(
      await options.lifecycle.inventory(),
      records.operations.some(
        (entry) => entry.phase === 'prepared' || entry.phase === 'needs_review',
      ),
    );
  });
  const importContext = async () => {
    const records = await options.lifecycle.safety.read();
    return {
      state: await options.lifecycle.inventory(),
      blocked: records.operations.some(
        (entry) => entry.phase === 'prepared' || entry.phase === 'needs_review',
      ),
    };
  };
  app.post('/api/imports/preview', async (request) => {
    const context = await importContext();
    return imports.preview(
      request.body,
      request.cookies.waleed_hub_session!,
      context.state,
      context.blocked,
    );
  });
  app.post(
    '/api/bundles/preview',
    { bodyLimit: MCPB_MAX_ARCHIVE_BYTES },
    async (request) => {
      if (!Buffer.isBuffer(request.body))
        throw new HubError('invalid', 'Upload a binary .mcpb archive.');
      return options.lifecycle.bundles.preview(
        request.body,
        request.cookies.waleed_hub_session!,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/bundles/:id/install',
    async (request) =>
      options.lifecycle.bundles.install(
        request.params.id,
        request.body,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/bundles/:id/cancel',
    async (request) =>
      options.lifecycle.bundles.cancel(
        request.params.id,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.get<{ Params: { id: string } }>('/api/imports/:id', async (request) => {
    const context = await importContext();
    return imports.read(
      IdSchema.parse(request.params.id),
      request.cookies.waleed_hub_session!,
      context.state,
      context.blocked,
    );
  });
  app.post<{ Params: { id: string } }>(
    '/api/imports/:id/selection',
    async (request) => {
      const context = await importContext();
      return imports.select(
        IdSchema.parse(request.params.id),
        request.body,
        request.cookies.waleed_hub_session!,
        context.state,
        context.blocked,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/imports/:id/cancel',
    async (request) => {
      if (
        !request.body ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length
      )
        throw new HubError(
          'invalid',
          'Cancellation accepts only an empty object.',
        );
      return imports.cancel(
        IdSchema.parse(request.params.id),
        request.cookies.waleed_hub_session!,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/imports/:id/save-preview',
    async (request) => {
      const { expectedRevision } = ImportSavePreviewRequestSchema.parse(
        request.body,
      );
      const context = await importContext();
      const owner = request.cookies.waleed_hub_session!;
      const preview = imports.read(
        IdSchema.parse(request.params.id),
        owner,
        context.state,
        context.blocked,
      );
      if (
        preview.expectedRevision !== expectedRevision ||
        !preview.selectionReady
      )
        throw new HubError(
          'conflict',
          'Review and resolve import conflicts first.',
        );
      if (preview.secretReferences.length)
        throw new HubError(
          'unavailable',
          'Private import values are not promoted automatically. Save a value-free definition and enter credentials through Authentication.',
        );
      const operation = await options.lifecycle.preview(
        {
          kind: 'create_connectors',
          expectedRevision,
          definitions: preview.entries.flatMap((entry) =>
            entry.selected && entry.definition ? [entry.definition] : [],
          ),
        },
        owner,
      );
      imports.cancel(preview.id, owner);
      return operation;
    },
  );
  app.post<{ Params: { agentId: string } }>(
    '/api/adoption/agents/:agentId/preview',
    async (request) =>
      options.lifecycle.adoption.preview(
        IntegrationAgentIdSchema.parse(request.params.agentId),
        request.body,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/imports/:id/apply',
    async (request) =>
      options.lifecycle.adoption.apply(
        IdSchema.parse(request.params.id),
        request.body,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/check',
    async (request, reply) => {
      if (
        !request.body ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length
      )
        throw new HubError('invalid', 'Checks accept only an empty object.');
      return reply
        .code(202)
        .send(
          await options.lifecycle.checks.start(
            IdSchema.parse(request.params.id),
            request.cookies.waleed_hub_session!,
          ),
        );
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/runtime/jobs/:id',
    async (request) =>
      options.lifecycle.checks.job(
        IdSchema.parse(request.params.id),
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/runtime/jobs/:id/cancel',
    async (request) =>
      options.lifecycle.checks.cancel(
        IdSchema.parse(request.params.id),
        request.cookies.waleed_hub_session!,
      ),
  );
  app.get('/api/credentials', async () => ({
    references: (await options.lifecycle.inventory()).secretReferences,
  }));
  app.post('/api/agents/scan', async () =>
    options.lifecycle.integrations.scan(),
  );
  app.post('/api/desktop/shutdown', async () => {
    if (!options.shutdown)
      throw new HubError('unavailable', 'Desktop shutdown is unavailable.');
    setImmediate(options.shutdown);
    return { stopping: true };
  });
  app.post('/api/agents/sync', async () =>
    options.lifecycle.integrations.sync(),
  );
  app.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/status',
    async (request) =>
      options.lifecycle.integrations.status(
        IntegrationAgentIdSchema.parse(request.params.agentId),
      ),
  );
  app.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/integrate',
    async (request) =>
      options.lifecycle.integrations.integrate(
        IntegrationAgentIdSchema.parse(request.params.agentId),
        request.body,
      ),
  );
  app.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/disconnect',
    async (request) =>
      options.lifecycle.integrations.disconnect(
        IntegrationAgentIdSchema.parse(request.params.agentId),
        request.body,
      ),
  );
  app.post('/api/connectors/manual', async (request) => {
    const body = request.body;
    request.body = undefined;
    return addManualMcp(
      options.lifecycle,
      body,
      request.cookies.waleed_hub_session!,
    );
  });
  app.get<{ Params: { id: string } }>(
    '/api/connectors/:id/auth',
    async (request) =>
      options.lifecycle.auth.status(IdSchema.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/credentials',
    async (request) => {
      const body = request.body;
      request.body = undefined;
      return options.lifecycle.auth.credentials.write(
        IdSchema.parse(request.params.id),
        body,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/credentials/:id/delete',
    async (request) => {
      const input = SecretDeleteSchema.parse(request.body);
      return options.lifecycle.auth.credentials.delete(
        IdSchema.parse(request.params.id),
        input.expectedRevision,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/oauth',
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await options.lifecycle.auth.start(
            IdSchema.parse(request.params.id),
            request.body,
            request.cookies.waleed_hub_session!,
          ),
        ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/oauth/refresh',
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await options.lifecycle.auth.start(
            IdSchema.parse(request.params.id),
            request.body,
            request.cookies.waleed_hub_session!,
            true,
          ),
        ),
  );
  app.get('/api/oauth/accounts', async () => options.lifecycle.auth.accounts());
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/oauth/discover',
    async (request) =>
      options.lifecycle.auth.discover(
        IdSchema.parse(request.params.id),
        request.body,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/oauth/disconnect',
    async (request) =>
      options.lifecycle.auth.disconnect(
        IdSchema.parse(request.params.id),
        request.body,
      ),
  );
  app.get<{ Params: { id: string } }>('/api/auth/jobs/:id', async (request) =>
    options.lifecycle.auth.job(
      IdSchema.parse(request.params.id),
      request.cookies.waleed_hub_session!,
    ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/auth/jobs/:id/cancel',
    async (request) =>
      options.lifecycle.auth.cancel(
        IdSchema.parse(request.params.id),
        request.cookies.waleed_hub_session!,
      ),
  );
  app.get('/api/activity', async () => ({
    events: (await options.lifecycle.inventory()).activity,
  }));
  app.get('/api/registry/servers', async (request) =>
    registry.search(request.query),
  );
  app.get('/api/security-activity', async () => ({
    events: (await options.lifecycle.safety.read()).securityEvents,
  }));
  app.get('/api/recovery', async () => {
    const { operations } = await options.lifecycle.safety.read();
    return {
      blocked: operations.some(
        (operation) =>
          operation.phase === 'prepared' || operation.phase === 'needs_review',
      ),
      operations,
    };
  });
  app.get('/api/settings', async () => ({
    startup: options.lifecycle.capabilities.startup
      ? 'hkcu_run_opt_in'
      : 'unavailable',
    secretStore: 'not_implemented',
    discovery: options.discovery ? 'read_only' : 'unavailable',
    storage: 'versioned_json',
    backupLimit: 5,
  }));
  app.get('/api/setup/export', async (_request, reply) => {
    const bundle = await options.lifecycle.setup.export();
    return reply
      .header('Content-Disposition', 'attachment; filename="setup.json"')
      .type('application/json')
      .send(bundle);
  });
  app.post(
    '/api/setup/import/preview',
    { bodyLimit: SETUP_MAX_BYTES * 6 + 4096 },
    async (request) =>
      options.lifecycle.setup.preview(
        request.body,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post(
    '/api/setup/import/apply',
    { bodyLimit: 3 * 1024 * 1024 },
    async (request) =>
      options.lifecycle.setup.apply(
        request.body,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/setup/import/:id/cancel',
    async (request) =>
      options.lifecycle.setup.cancel(
        request.params.id,
        request.cookies.waleed_hub_session!,
      ),
  );
  app.post('/api/operations/preview', async (request) =>
    options.lifecycle.preview(
      request.body,
      request.cookies.waleed_hub_session!,
    ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/tool-policies',
    async (request) => {
      const input = ToolPoliciesUpdateSchema.parse(request.body),
        owner = request.cookies.waleed_hub_session!,
        connectorId = IdSchema.parse(request.params.id);
      const preview = await options.lifecycle.preview(
        { ...input, connectorId, kind: 'set_tool_policies' },
        owner,
      );
      const job = await options.lifecycle.apply(preview.id, owner);
      let result = options.lifecycle.job(job.id, owner);
      // Wait only for this registry mutation, not unrelated capability checks.
      while (result.state === 'queued' || result.state === 'running') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        result = options.lifecycle.job(job.id, owner);
      }
      if (result.state !== 'succeeded')
        throw new HubError(
          'conflict',
          'Permissions were not saved. Refresh inventory and inspect recovery before retrying.',
        );
      return { state: 'saved', recoveryRequired: !!result.reason };
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/tool-override',
    async (request) => {
      const input = ToolOverrideUpdateSchema.parse(request.body),
        connectorId = IdSchema.parse(request.params.id),
        owner = request.cookies.waleed_hub_session!;
      const preview = await options.lifecycle.preview(
          { ...input, connectorId, kind: 'set_tool_override' },
          owner,
        ),
        job = await options.lifecycle.apply(preview.id, owner);
      let result = options.lifecycle.job(job.id, owner);
      while (result.state === 'queued' || result.state === 'running') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        result = options.lifecycle.job(job.id, owner);
      }
      if (result.state !== 'succeeded')
        throw new HubError(
          'conflict',
          'Tool override was not confirmed. Refresh inventory and inspect recovery.',
        );
      return { state: 'saved', recoveryRequired: !!result.reason };
    },
  );
  app.post('/api/operations/apply', async (request, reply) => {
    const { previewId } = ApplyRequestSchema.parse(request.body);
    const job = await options.lifecycle.apply(
      previewId,
      request.cookies.waleed_hub_session!,
    );
    return reply.code(202).send(job);
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) =>
    options.lifecycle.job(
      IdSchema.parse(request.params.id),
      request.cookies.waleed_hub_session!,
    ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/cancel',
    async (request) =>
      options.lifecycle.cancel(
        IdSchema.parse(request.params.id),
        request.cookies.waleed_hub_session!,
      ),
  );

  if (options.webRoot) {
    // Static assets are public, but every API route independently requires a session.
    await app.register(async (assets) => {
      assets.addHook('onRoute', (route) => {
        route.config = { ...route.config, public: true };
      });
      await assets.register(staticFiles, {
        root: options.webRoot!,
        wildcard: false,
        globIgnore: ['**/*.map'],
        setHeaders: (reply) => {
          reply.header('Cache-Control', 'no-store');
        },
      });
    });
  }
  app.addHook('onClose', async () => {
    imports.close();
    sessions.clear();
    await options.discovery?.close();
    await options.lifecycle.close();
  });
  return { app, origin, issueLaunchToken: () => sessions.issueLaunchToken() };
}

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
    mcpBearer?: boolean;
  }
}
