import { randomUUID } from 'node:crypto';
import {
  RegistryOperationSchema,
  type RegistryOperation,
  type HubState,
  type Job,
  type OperationPreview,
} from '@waleed/contracts';
import { HubError, RevisionConflictError } from './errors.js';
import type { StateStore } from './state.js';
import {
  createMemorySafetyLedger,
  stateHash,
  type SafetyLedger,
} from './safety.js';
import { publicError } from './diagnostics.js';
import {
  planRegistry,
  planPackageReplace,
  type PackageReplaceInput,
  type RegistryContext,
  type RegistryPlan,
} from './runtime/registry.js';
import { createRuntimeChecks } from './runtime/checks.js';
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
import {
  createIntegrationEngine,
  type IntegrationAdapters,
} from './integrations/engine.js';
import {
  createPackageService,
  type PackageHost,
  type PackageService,
  type PackageServiceAdapter,
} from './packages/service.js';

interface Draft {
  input: RegistryOperation;
  preview: OperationPreview;
  owner: string;
  external?: MaterializationPlan;
  // The trusted context of an internal caller. Only the package service passes
  // one; the HTTP routes never do.
  context?: RegistryContext;
}
export interface LifecycleAdapters {
  integrations?: IntegrationAdapters;
  materializer?: Materializer;
  runtime?: CapabilityRuntime;
  secrets?: SecretBackends;
  oauthRecipes?: readonly OAuthRecipe[];
  oauthTimeoutMs?: number;
  oauthFlows?: { begin: typeof beginOAuth; refresh: typeof refreshOAuth };
  packages?: PackageServiceAdapter;
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
  );
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
  let packages: PackageService | null = null;
  // The removal hook of a committed mutation: an install folder that no
  // connector references any more is deleted in the background. The mutation
  // never waits for the deletion and never fails because of it.
  const removalHook = (before: HubState, after: HubState): void => {
    const kept = new Set<string>();
    for (const connector of after.connectors)
      if (connector.executionMode === 'native' && connector.package)
        kept.add(connector.package.installId);
    let orphaned = false;
    for (const connector of before.connectors)
      if (
        connector.executionMode === 'native' &&
        connector.package &&
        !kept.has(connector.package.installId)
      )
        orphaned = true;
    if (!orphaned) return;
    void packages?.reconcile().catch(() => undefined);
  };
  // The commit of one registry mutation. The build function plans it; the
  // journal, the write, the read-back recovery and the timers are the same
  // for every operation.
  const run = async (
    job: Job,
    controller: AbortController,
    build: (state: HubState) => RegistryPlan,
    external?: MaterializationPlan,
  ): Promise<void> => {
    let prepared = false,
      receipt: { rollback(): Promise<void> } | undefined;
    let plan: RegistryPlan | undefined;
    let before: HubState | undefined;
    let beforeHash = '',
      afterHash = '';
    let startedExternal = false;
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      if (job.state === 'cancelled') return;
      job.state = 'running';
      const state = await store.read();
      before = state;
      plan = build(state);
      if (external) attachExternal(plan, external);
      plan.next.activity.push({
        id: job.id,
        time: timestamp(),
        operation: job.operation,
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
        operation: job.operation,
        targetId: plan.targetId,
        expectedRevision: state.revision,
        beforeHash,
        afterHash,
        phase: 'prepared',
        reason: 'none',
        createdAt: job.createdAt,
        updatedAt: timestamp(),
        ...(external ? { external: true } : {}),
      });
      prepared = true;
      if (external) {
        startedExternal = true;
        receipt = await adapters.materializer!.apply(
          external,
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
      // The commit is confirmed: a folder nobody owns any more goes away.
      removalHook(state, plan.next);
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
            // The read-back confirmed the commit: the same removal hook runs.
            if (before) removalHook(before, plan.next);
          } else if (actual === beforeHash) {
            if (receipt) await receipt.rollback();
            else if (
              startedExternal &&
              (!(error instanceof MaterializationFault) || !error.restored)
            )
              throw new HubError('unavailable', 'External state is uncertain.');
            await safety.finish(job.id, 'aborted', 'commit_failed');
          } else await safety.finish(job.id, 'needs_review', 'state_drift');
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
  };
  const lifecycle = {
    safety,
    checks,
    auth,
    integrations,
    capabilities: {
      materialization: !!adapters.materializer,
      runtimeChecks: !!adapters.runtime,
      secrets: credentials.enabled,
      agentApply: integrations.enabled,
    },
    inventory: () => store.read(),
    async preview(
      raw: unknown,
      owner: string,
      context?: RegistryContext,
    ): Promise<OperationPreview> {
      if (closed) throw new HubError('unavailable', 'Lifecycle is closed.');
      const input = RegistryOperationSchema.parse(raw);
      await safety.assertWritable();
      const state = await store.read();
      const targetId =
        'profileId' in input
          ? input.profileId
          : 'connectorId' in input
            ? input.connectorId
            : randomUUID();
      const plan = planRegistry(input, state, targetId, timestamp(), context);
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
          ...new Set(
            (state.agentBindings ?? [])
              .filter((binding) =>
                plan.affectedProfiles.includes(binding.profileId),
              )
              .map((binding) => binding.agentId),
          ),
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
        ...(context ? { context } : {}),
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
          throw new RevisionConflictError(
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
          void run(
            job,
            controller,
            (state) =>
              planRegistry(
                draft.input,
                state,
                draft.preview.targetId!,
                timestamp(),
                draft.context,
              ),
            draft.external,
          );
        });
        return structuredClone(job);
      } finally {
        accepting = false;
      }
    },
    // The removal of a draft that will never be applied. Only the owner of
    // the draft can drop it, and nothing else happens: no job, no state and
    // no file.
    discard(previewId: string, owner: string): void {
      const draft = drafts.get(previewId);
      if (!draft || draft.owner !== owner) return;
      drafts.delete(previewId);
    },
    // The internal replacement of an installed package. Only the package
    // service calls it; it is never exposed through an HTTP route.
    async replacePackage(
      input: PackageReplaceInput,
      owner: string,
    ): Promise<Job> {
      if (closed) throw new HubError('unavailable', 'Lifecycle is closed.');
      if (accepting || active)
        throw new HubError('busy', 'Another mutation is in progress.');
      accepting = true;
      try {
        await safety.assertWritable();
        if (jobs.size >= 100) {
          const oldest = [...jobs.values()].find(
            (entry) => entry.job.completedAt,
          );
          if (oldest) jobs.delete(oldest.job.id);
        }
        const job: Job = {
          id: randomUUID(),
          operation: 'edit_connector',
          state: 'queued',
          createdAt: timestamp(),
          completedAt: null,
          reason: null,
          resultId: null,
        };
        const controller = new AbortController();
        jobs.set(job.id, { owner, job, controller, external: false });
        active = true;
        setImmediate(() => {
          void run(job, controller, (state) =>
            planPackageReplace(state, input, timestamp()),
          );
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
      // The package jobs finish first: their save needs the lifecycle, so the
      // lifecycle stays open until they reported their real outcome.
      await packages?.close();
      closed = true;
      drafts.clear();
      for (const entry of jobs.values())
        if (entry.external && !entry.job.completedAt) entry.controller.abort();
      await auth.close();
      await checks.close();
      while (active)
        await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  if (adapters.packages) {
    // The service sees a narrow host, never the whole lifecycle.
    const host: PackageHost = {
      preview: (raw, owner, context) => lifecycle.preview(raw, owner, context),
      apply: (previewId, owner) => lifecycle.apply(previewId, owner),
      discard: (previewId, owner) => lifecycle.discard(previewId, owner),
      replacePackage: (input, owner) => lifecycle.replacePackage(input, owner),
      drain: () => lifecycle.drain(),
      job: (id, owner) => lifecycle.job(id, owner),
      inventory: () => lifecycle.inventory(),
      auth: {
        credentials: {
          write: (connectorId, raw) =>
            lifecycle.auth.credentials.write(connectorId, raw),
        },
      },
    };
    packages = createPackageService(host, adapters.packages);
  }
  return { ...lifecycle, packages };
}
export type HubLifecycle = ReturnType<typeof createLifecycle>;
