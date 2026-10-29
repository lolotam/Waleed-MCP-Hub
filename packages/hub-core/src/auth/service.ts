import { randomUUID } from 'node:crypto';
import { OAuthStartSchema, type AuthJob } from '@waleed/contracts';
import type { StateStore } from '../state.js';
import type { SafetyLedger } from '../safety.js';
import type { Credentials } from './credentials.js';
import { sameDefinition } from './credentials.js';
import { requireConnector } from '../runtime/registry.js';
import { HubError } from '../errors.js';
import {
  AuthFault,
  beginOAuth,
  refreshOAuth,
  supportedOAuthRecipes,
  type OAuthRecipe,
} from './oauth-flow.js';
import type { createRuntimeChecks } from '../runtime/checks.js';

export function createAuthService(
  store: StateStore,
  safety: SafetyLedger,
  credentials: Credentials,
  checks: ReturnType<typeof createRuntimeChecks>,
  recipes: readonly OAuthRecipe[] = supportedOAuthRecipes,
  now: () => number = Date.now,
  timeoutMs = 120_000,
  flows = { begin: beginOAuth, refresh: refreshOAuth },
) {
  const jobs = new Map<
    string,
    {
      owner: string;
      controller: AbortController;
      job: AuthJob;
      task: Promise<void>;
    }
  >();
  let closed = false;
  const own = (id: string, owner: string) => {
    const entry = jobs.get(id);
    if (!entry || entry.owner !== owner)
      throw new HubError('not_found', 'Authentication job not found.');
    return entry;
  };
  return {
    credentials,
    async status(id: string) {
      const state = await store.read();
      const connector = requireConnector(state, id);
      const refs = state.secretReferences.filter((reference) =>
        [
          ...Object.values(connector.secretBindings),
          ...Object.values(connector.headerBindings),
        ].includes(reference.id),
      );
      return {
        connectorId: id,
        revision: connector.revision,
        credentials: refs.map(({ id, adapter, present, kind }) => ({
          id,
          adapter,
          present,
          kind: kind ?? 'credential',
        })),
        recipes: recipes
          .filter(
            (recipe) =>
              connector.executionMode === 'remote' &&
              recipe.endpoint === connector.endpoint,
          )
          .map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            scopes: recipe.scopes,
            issuer: recipe.issuer,
            revocationSupported: false,
          })),
        state:
          (await checks.observations()).find(
            (observation) => observation.connectorId === id,
          )?.state ?? 'untested',
        localDeletionRevokesProvider: false,
      };
    },
    async start(
      connectorId: string,
      raw: unknown,
      owner: string,
      refresh = false,
    ) {
      if (closed || !credentials.backends.windows?.read)
        throw new HubError(
          'unavailable',
          'Current-user protected storage is required for OAuth.',
        );
      const input = OAuthStartSchema.parse(raw);
      await safety.assertWritable();
      const state = await store.read();
      const connector = requireConnector(state, connectorId);
      if (
        state.revision !== input.expectedRevision ||
        !sameDefinition(
          connector,
          input.expectedConnectorRevision,
          input.definitionHash,
        )
      )
        throw new HubError(
          'conflict',
          'Approve a fresh enabled definition before sign-in/discovery.',
        );
      const recipe = recipes.find(
        (recipe) =>
          recipe.id === input.recipeId &&
          connector.executionMode === 'remote' &&
          recipe.endpoint === connector.endpoint,
      );
      if (!recipe)
        throw new HubError(
          'unavailable',
          'This endpoint has no verified supported OAuth recipe.',
        );
      if (
        [...jobs.values()].some(
          (entry) =>
            !entry.job.completedAt && entry.job.connectorId === connectorId,
        ) ||
        [...jobs.values()].filter((entry) => !entry.job.completedAt).length >= 2
      )
        throw new HubError('busy', 'Authentication job limit reached.');
      while (jobs.size >= 50) {
        const oldest = [...jobs.values()].find(
          (entry) => entry.job.completedAt,
        );
        if (!oldest)
          throw new HubError('busy', 'Authentication job retention full.');
        jobs.delete(oldest.job.id);
      }
      const job: AuthJob = {
        id: randomUUID(),
        connectorId,
        recipeId: recipe.id,
        state: 'starting',
        reason: 'none',
        authorizationUrl: null,
        scopes: [...recipe.scopes],
        createdAt: new Date(now()).toISOString(),
        completedAt: null,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => {
        job.reason = 'timed_out';
        controller.abort();
      }, timeoutMs);
      const task = Promise.resolve().then(async () => {
        let value: Buffer | undefined;
        let close: (() => void) | undefined;
        try {
          if (controller.signal.aborted) throw new AuthFault('cancelled');
          await credentials.backends.windows!.has(
            `wmh-secret-${randomUUID()}`,
            controller.signal,
          );
          if (controller.signal.aborted) throw new AuthFault('cancelled');
          await safety.assertWritable();
          const ready = await store.read();
          if (
            ready.revision !== input.expectedRevision ||
            !sameDefinition(
              requireConnector(ready, connectorId),
              input.expectedConnectorRevision,
              input.definitionHash,
            )
          )
            throw new AuthFault('definition_changed');
          if (refresh) {
            const reference = state.secretReferences.find(
              (reference) =>
                reference.id === connector.headerBindings.Authorization &&
                reference.kind === 'oauth' &&
                reference.recipeId === recipe.id,
            );
            if (!reference) throw new AuthFault('unsupported');
            const previous = await credentials.backends.windows!.read!(
              reference.id,
              controller.signal,
            );
            try {
              value = await flows.refresh(
                recipe,
                previous,
                controller.signal,
                now,
              );
            } finally {
              previous.fill(0);
            }
          } else {
            const flow = await flows.begin(recipe, controller.signal, now);
            close = flow.close;
            job.authorizationUrl = flow.authorizationUrl;
            job.state = 'awaiting_user';
            value = await flow.finish();
            job.authorizationUrl = null;
          }
          if (controller.signal.aborted) throw new AuthFault('cancelled');
          const currentState = await store.read();
          const current = requireConnector(currentState, connectorId);
          if (
            currentState.revision !== input.expectedRevision ||
            !sameDefinition(
              current,
              input.expectedConnectorRevision,
              input.definitionHash,
            )
          )
            throw new AuthFault('definition_changed');
          job.state = 'saving';
          await credentials.commit(
            connectorId,
            {
              expectedRevision: currentState.revision,
              expectedConnectorRevision: current.revision,
              location: 'header',
              name: 'Authorization',
              format: 'bearer',
              adapter: 'windows',
            },
            value,
            { recipeId: recipe.id, carryApproval: true },
          );
          value = undefined;
          if (controller.signal.aborted) throw new AuthFault('cancelled');
          job.state = 'checking';
          const check = await checks.start(connectorId, owner);
          const abort = () => {
            checks.cancel(check.id, owner);
          };
          controller.signal.addEventListener('abort', abort, { once: true });
          try {
            if (controller.signal.aborted) abort();
            await checks.drain();
          } finally {
            controller.signal.removeEventListener('abort', abort);
          }
          const result = checks.job(check.id, owner);
          if (result.state !== 'succeeded')
            throw new AuthFault(
              result.reason === 'auth_expired'
                ? 'expired'
                : result.reason === 'auth_required'
                  ? 'auth_required'
                  : 'dependency_unavailable',
            );
          if (controller.signal.aborted) throw new AuthFault('cancelled');
          job.state = 'succeeded';
        } catch (error) {
          job.reason =
            job.reason === 'timed_out'
              ? 'timed_out'
              : controller.signal.aborted
                ? 'cancelled'
                : error instanceof AuthFault
                  ? error.reason
                  : 'dependency_unavailable';
          job.state = job.reason === 'cancelled' ? 'cancelled' : 'failed';
        } finally {
          clearTimeout(timer);
          close?.();
          value?.fill(0);
          job.authorizationUrl = null;
          job.completedAt = new Date(now()).toISOString();
        }
      });
      jobs.set(job.id, { owner, job, controller, task });
      return structuredClone(job);
    },
    job(id: string, owner: string) {
      return structuredClone(own(id, owner).job);
    },
    cancel(id: string, owner: string) {
      const entry = own(id, owner);
      if (!entry.job.completedAt) entry.controller.abort();
      return structuredClone(entry.job);
    },
    revokeSession(owner: string) {
      for (const entry of jobs.values())
        if (entry.owner === owner && !entry.job.completedAt)
          entry.controller.abort();
    },
    async drain() {
      await Promise.all([...jobs.values()].map((entry) => entry.task));
    },
    async close() {
      closed = true;
      for (const entry of jobs.values()) entry.controller.abort();
      await Promise.all([...jobs.values()].map((entry) => entry.task));
    },
  };
}
