import { randomUUID } from 'node:crypto';
import {
  createClientTokens,
  memoryClientTokenStore,
  type ClientTokenStore,
} from './http/tokens.js';
import { createAgentBridge } from './integrations/bridge.js';
import type { CredentialStorageDiagnostics } from './auth/secrets.js';
import { unconfiguredCredentialStorage } from './adapters/secrets/platform.js';
import { createMcpbService } from './integrations/mcpb.js';
import { createSetupService } from './setup/service.js';
import type { McpbAdapter } from './adapters/mcpb.js';
import {
  createPlayground,
  type PlaygroundConnect,
} from './integrations/playground.js';
import { createRequestLog } from './integrations/request-log.js';
import { startRequestLogServer } from './integrations/request-log-ipc.js';
import {
  RegistryOperationSchema,
  IntegrationAgentIdSchema,
  type RegistryOperation,
  type Job,
  type OperationPreview,
} from '@waleed/contracts';
import { HubError } from './errors.js';
import type { StateStore } from './state.js';
import {
  createMemorySafetyLedger,
  stateHash,
  type SafetyLedger,
} from './safety.js';
import { publicError } from './diagnostics.js';
import { planRegistry, type RegistryPlan } from './runtime/registry.js';
import { createRuntimeChecks } from './runtime/checks.js';
import { createConnectorHealth } from './runtime/health.js';
import {
  createLifecycleSettings,
  type LifecyclePreferencesStore,
  type StartupRegistration,
} from './runtime/lifecycle-settings.js';
import {
  MaterializationFault,
  type Materializer,
  type MaterializationPlan,
} from './runtime/materialize.js';
import type { CapabilityRuntime } from './runtime/capabilities.js';
import { createCredentials, type MutationLock } from './auth/credentials.js';
import { createAuthService } from './auth/service.js';
import type { SecretBackends } from './auth/secrets.js';
import type { OAuthRecipe } from './auth/oauth-flow.js';
import type { beginOAuth, refreshOAuth } from './auth/oauth-flow.js';
import type { discoverOAuth } from './auth/oauth-discovery.js';
import { createAdoptionEngine } from './integrations/adoption.js';
import {
  createIntegrationEngine,
  type IntegrationAdapters,
} from './integrations/engine.js';

interface Draft {
  input: RegistryOperation;
  preview: OperationPreview;
  owner: string;
  external?: MaterializationPlan;
}
export interface LifecycleAdapters {
  credentialStorage?: CredentialStorageDiagnostics;
  clientTokens?: ClientTokenStore;
  lifecyclePreferences?: LifecyclePreferencesStore;
  startup?: StartupRegistration;
  playgroundConnect?: PlaygroundConnect;
  requestLogDirectory?: string;
  bundles?: McpbAdapter;
  integrations?: IntegrationAdapters;
  materializer?: Materializer;
  runtime?: CapabilityRuntime;
  secrets?: SecretBackends;
  oauthRecipes?: readonly OAuthRecipe[];
  oauthTimeoutMs?: number;
  oauthFlows?: { begin: typeof beginOAuth; refresh: typeof refreshOAuth };
  oauthDiscovery?: typeof discoverOAuth;
}
export function createLifecycle(
  store: StateStore,
  now: () => number = Date.now,
  safety: SafetyLedger = createMemorySafetyLedger(now),
  adapters: LifecycleAdapters = {},
) {
  const drafts = new Map<string, Draft>();
  const jobs = new Map<
    string,
    { owner: string; job: Job; controller: AbortController; external: boolean }
  >();
  const checks = createRuntimeChecks(
    store,
    safety,
    adapters.runtime,
    now,
    !!adapters.secrets,
  );
  let active = false,
    accepting = false,
    closed = false;
  const timestamp = () => new Date(now()).toISOString();
  const mutation: MutationLock = async (action) => {
    if (closed) throw new HubError('unavailable', 'Lifecycle is closed.');
    if (active || accepting)
      throw new HubError('busy', 'Another mutation is in progress.');
    active = true;
    try {
      return await action();
    } finally {
      active = false;
    }
  };
  const credentials = createCredentials(
    store,
    safety,
    adapters.secrets ?? {},
    mutation,
    checks.invalidate,
    now,
  );
  const integrations = createIntegrationEngine(
    store,
    safety,
    mutation,
    adapters.integrations,
  );
  const auth = createAuthService(
    store,
    safety,
    credentials,
    checks,
    adapters.oauthRecipes,
    now,
    adapters.oauthTimeoutMs,
    adapters.oauthFlows,
    adapters.oauthDiscovery,
  );
  const settings = createLifecycleSettings(
    adapters.lifecyclePreferences,
    adapters.startup,
    () => safety.assertWritable(),
  );
  const health = createConnectorHealth(
    store,
    safety,
    checks,
    adapters.secrets ?? {},
    settings,
    auth.healthRefreshFailed,
    now,
  );
  const adoption = createAdoptionEngine(
    store,
    safety,
    mutation,
    adapters.secrets ?? {},
    adapters.integrations,
    checks.invalidate,
    now,
  );
  const bundles = createMcpbService(
    store,
    safety,
    mutation,
    adapters.secrets ?? {},
    adapters.bundles,
    now,
  );
  const requestLog = createRequestLog({ now });
  const setup = createSetupService(
    store,
    safety,
    mutation,
    adapters.secrets ?? {},
    checks.invalidate,
    now,
  );
  const playgroundRead = async () => {
    if (closed) throw new HubError('unavailable', 'Lifecycle is closed.');
    await safety.assertWritable();
    return store.read();
  };
  const playground = createPlayground(
    playgroundRead,
    requestLog,
    adapters.playgroundConnect,
    now,
  );
  const httpTokens = createClientTokens({
    store: adapters.clientTokens ?? memoryClientTokenStore(),
    registry: store,
    mutation,
    assertWritable: () => safety.assertWritable(),
    now,
  });
  const httpBridges = new Set<ReturnType<typeof createAgentBridge>>();
  const http = {
    tokens: httpTokens,
    async bridge(tokenId: string) {
      if (!adapters.playgroundConnect)
        throw new HubError('unavailable', 'HTTP bridge is unavailable.');
      const token = await httpTokens.requireActive(tokenId);
      const read = async () => {
        const current = await httpTokens.requireActive(tokenId);
        const state = await playgroundRead();
        if (!current.profileId) return state;
        const profile = state.profiles.find(
          (item) => item.id === current.profileId && item.enabled !== false,
        );
        // Filter a snapshot only. The bridge still applies live agent-profile limits,
        // tool policies, approvals and credentials, so this cannot widen a binding.
        return {
          ...state,
          connectors: state.connectors.filter((connector) =>
            profile?.connectorIds.includes(connector.id),
          ),
        };
      };
      const bridge = createAgentBridge(
        read,
        adapters.playgroundConnect,
        token.agentId ?? 'http-client',
        {},
        requestLog,
      );
      httpBridges.add(bridge);
      return { bridge, release: () => httpBridges.delete(bridge) };
    },
  };
  let agentLogChannel: 'available' | 'unavailable' | 'not_configured' =
    adapters.requestLogDirectory ? 'unavailable' : 'not_configured';
  const collector = adapters.requestLogDirectory
    ? startRequestLogServer(
        adapters.requestLogDirectory,
        requestLog,
        playgroundRead,
      ).then(
        (server) => {
          agentLogChannel = 'available';
          return server;
        },
        () => undefined,
      )
    : Promise.resolve(undefined);
  const prune = () => {
    for (const [id, draft] of drafts)
      if (Date.parse(draft.preview.expiresAt) <= now()) drafts.delete(id);
  };
  const attachExternal = (
    plan: RegistryPlan,
    external: MaterializationPlan,
  ) => {
    plan.next.materializations = (plan.next.materializations ?? []).filter(
      (record) => record.profileId !== external.profileId,
    );
    if (external.record) plan.next.materializations.push(external.record);
    const profile = plan.next.profiles.find(
      (profile) => profile.id === external.profileId,
    )!;
    profile.dockerProfileId = external.record?.dockerProfileId ?? null;
  };
  return {
    credentialStorage:
      adapters.credentialStorage ?? unconfiguredCredentialStorage(),
    safety,
    checks,
    settings,
    health,
    auth,
    integrations,
    adoption,
    bundles,
    setup,
    playground,
    http,
    requestLog,
    requestLogSnapshot: () => ({
      records: requestLog.records(),
      capacity: 500 as const,
      agentLogChannel,
    }),
    capabilities: {
      materialization: !!adapters.materializer,
      runtimeChecks: !!adapters.runtime,
      secrets: credentials.enabled,
      agentApply: integrations.enabled,
      playground: playground.enabled,
      startup: settings.startupAvailable,
    },
    inventory: () => store.read(),
    async preview(raw: unknown, owner: string): Promise<OperationPreview> {
      if (closed) throw new HubError('unavailable', 'Lifecycle is closed.');
      const input = RegistryOperationSchema.parse(raw);
      await safety.assertWritable();
      const state = await store.read();
      const targetId =
        'agentId' in input
          ? input.agentId
          : 'profileId' in input
            ? input.profileId
            : 'connectorId' in input
              ? input.connectorId
              : randomUUID();
      const plan = planRegistry(
        input,
        state,
        targetId,
        timestamp(),
        input.kind === 'set_tool_override' ? await checks.observations() : [],
      );
      let external: MaterializationPlan | undefined;
      if (
        input.kind === 'materialize_profile' ||
        input.kind === 'dematerialize_profile'
      ) {
        if (!adapters.materializer)
          throw new HubError(
            'unavailable',
            'No verified materialization adapter is configured.',
          );
        external = await adapters.materializer.plan(
          state,
          input.profileId,
          input.kind === 'dematerialize_profile',
          AbortSignal.timeout(15_000),
        );
        attachExternal(plan, external);
      }
      prune();
      if (drafts.size >= 100)
        throw new HubError('busy', 'Too many pending previews.');
      const preview: OperationPreview = {
        id: randomUUID(),
        expectedRevision: state.revision,
        kind: input.kind,
        targetId: plan.targetId,
        summary:
          input.kind === 'create_profile'
            ? 'Create a local profile'
            : input.kind.replaceAll('_', ' '),
        changes:
          input.kind === 'create_profile'
            ? [
                'Add one empty profile to the hub registry.',
                'No Docker profile or agent configuration will change.',
              ]
            : plan.changes,
        warnings: external
          ? [
              'This apply writes only the listed owned files/profile snapshot. It does not start connectors or change agent configuration.',
              'Interrupted or unprovable external rollback blocks further mutations for recovery review.',
            ]
          : plan.warnings,
        affectedProfiles: plan.affectedProfiles,
        affectedAgents: [
          ...new Set([
            ...(state.agentBindings ?? [])
              .filter((binding) =>
                plan.affectedProfiles.includes(binding.profileId),
              )
              .map((binding) => binding.agentId),
            ...IntegrationAgentIdSchema.options.filter((agentId) =>
              plan.affectedProfiles.includes(
                state.agentProfileBindings?.[agentId] ?? '',
              ),
            ),
            ...('agentId' in input ? [input.agentId] : []),
          ]),
        ],
        files: external?.paths ?? [],
        expiresAt: new Date(now() + 5 * 60_000).toISOString(),
        ...(input.kind === 'approve_connector'
          ? { definitionHash: input.definitionHash }
          : {}),
      };
      drafts.set(preview.id, {
        input,
        preview,
        owner,
        ...(external ? { external } : {}),
      });
      return structuredClone(preview);
    },
    async apply(previewId: string, owner: string): Promise<Job> {
      if (closed) throw new HubError('unavailable', 'Lifecycle is closed.');
      if (accepting || active)
        throw new HubError('busy', 'Another mutation is in progress.');
      accepting = true;
      try {
        await safety.assertWritable();
        prune();
        const draft = drafts.get(previewId);
        if (!draft || draft.owner !== owner)
          throw new HubError('not_found', 'Preview is missing or expired.');
        if ((await store.read()).revision !== draft.input.expectedRevision)
          throw new HubError(
            'conflict',
            'Inventory changed. Create a new preview.',
          );
        if (jobs.size >= 100) {
          const oldest = [...jobs.values()].find(
            (entry) => entry.job.completedAt,
          );
          if (oldest) jobs.delete(oldest.job.id);
        }
        const job: Job = {
          id: randomUUID(),
          operation: draft.input.kind,
          state: 'queued',
          createdAt: timestamp(),
          completedAt: null,
          reason: null,
          resultId: null,
        };
        const controller = new AbortController();
        jobs.set(job.id, {
          owner,
          job,
          controller,
          external: !!draft.external,
        });
        drafts.delete(previewId);
        active = true;
        setImmediate(() => {
          void (async () => {
            let prepared = false,
              receipt: { rollback(): Promise<void> } | undefined;
            let plan: RegistryPlan | undefined;
            let beforeHash = '',
              afterHash = '';
            let startedExternal = false;
            const timer = setTimeout(() => controller.abort(), 60_000);
            try {
              if (job.state === 'cancelled') return;
              job.state = 'running';
              const state = await store.read();
              plan = planRegistry(
                draft.input,
                state,
                draft.preview.targetId!,
                timestamp(),
                draft.input.kind === 'set_tool_override'
                  ? await checks.observations()
                  : [],
              );
              if (draft.external) attachExternal(plan, draft.external);
              plan.next.activity.push({
                id: job.id,
                time: timestamp(),
                operation: draft.input.kind,
                targetId: plan.targetId,
                priorRevision: state.revision,
                newRevision: plan.next.revision,
                result: 'succeeded',
              });
              plan.next.activity = plan.next.activity.slice(-200);
              beforeHash = stateHash(state);
              afterHash = stateHash(plan.next);
              await safety.prepare({
                id: job.id,
                operation: draft.input.kind,
                targetId: plan.targetId,
                expectedRevision: state.revision,
                beforeHash,
                afterHash,
                phase: 'prepared',
                reason: 'none',
                createdAt: job.createdAt,
                updatedAt: timestamp(),
                ...(draft.external ? { external: true } : {}),
              });
              prepared = true;
              if (draft.external) {
                startedExternal = true;
                receipt = await adapters.materializer!.apply(
                  draft.external,
                  controller.signal,
                );
              }
              if (controller.signal.aborted)
                throw new HubError(
                  'unavailable',
                  'Operation cancelled before registry commit.',
                );
              await store.write(state.revision, plan.next);
              checks.invalidate(plan.affectedConnectors);
              job.state = 'succeeded';
              job.resultId = plan.targetId;
              try {
                await safety.finish(job.id, 'committed');
              } catch {
                job.reason =
                  'Saved, but journal finalization needs recovery review. Do not retry the save.';
              }
            } catch (error) {
              job.state = controller.signal.aborted ? 'cancelled' : 'failed';
              job.reason = publicError(error).message;
              if (prepared && plan) {
                try {
                  const actual = stateHash(await store.read());
                  if (actual === afterHash) {
                    job.state = 'succeeded';
                    job.resultId = plan.targetId;
                    checks.invalidate(plan.affectedConnectors);
                    job.reason =
                      'Saved; exact read-back confirmed the commit after a storage error. Do not repeat the operation.';
                    await safety.finish(job.id, 'committed');
                  } else if (actual === beforeHash) {
                    if (receipt) await receipt.rollback();
                    else if (
                      startedExternal &&
                      (!(error instanceof MaterializationFault) ||
                        !error.restored)
                    )
                      throw new HubError(
                        'unavailable',
                        'External state is uncertain.',
                      );
                    await safety.finish(job.id, 'aborted', 'commit_failed');
                  } else
                    await safety.finish(job.id, 'needs_review', 'state_drift');
                } catch {
                  try {
                    await safety.finish(job.id, 'needs_review', 'state_drift');
                  } catch {
                    /* Prepared journal remains blocking and durable. */
                  }
                  job.reason =
                    'Recovery review is required. No uncertain external state was overwritten or replayed.';
                }
              }
            } finally {
              clearTimeout(timer);
              job.completedAt = timestamp();
              active = false;
            }
          })();
        });
        return structuredClone(job);
      } finally {
        accepting = false;
      }
    },
    job(id: string, owner: string): Job {
      const entry = jobs.get(id);
      if (!entry || entry.owner !== owner)
        throw new HubError('not_found', 'Job not found in this session.');
      return structuredClone(entry.job);
    },
    cancel(id: string, owner: string): Job {
      const entry = jobs.get(id);
      if (!entry || entry.owner !== owner)
        throw new HubError('not_found', 'Job not found in this session.');
      if (entry.job.state === 'running') {
        if (!entry.external)
          throw new HubError(
            'conflict',
            'The atomic registry save has started.',
          );
        entry.controller.abort();
      }
      if (entry.job.state === 'queued') {
        entry.job.state = 'cancelled';
        entry.job.completedAt = timestamp();
      }
      return structuredClone(entry.job);
    },
    async drain() {
      while (active)
        await new Promise<void>((resolve) => setImmediate(resolve));
      await checks.drain();
    },
    async close() {
      closed = true;
      httpTokens.close();
      await Promise.allSettled(
        [...httpBridges].map((bridge) => bridge.close()),
      );
      httpBridges.clear();
      settings.close();
      await health.close();
      await playground.close();
      await (await collector)?.close();
      requestLog.clear();
      adoption.close();
      bundles.close();
      setup.close();
      drafts.clear();
      for (const entry of jobs.values())
        if (entry.external && !entry.job.completedAt) entry.controller.abort();
      await auth.close();
      await checks.close();
      while (active)
        await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
export type HubLifecycle = ReturnType<typeof createLifecycle>;
