import { randomUUID } from 'node:crypto';
import {
  OAuthStartSchema,
  OAuthDiscoverySchema,
  OAuthDisconnectSchema,
  type AuthJob,
} from '@waleed/contracts';
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
  type TokenBundle,
  revokeOAuth,
} from './oauth-flow.js';
import { discoverOAuth } from './oauth-discovery.js';
import { hashData } from '../runtime/registry.js';
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
  discovery = discoverOAuth,
) {
  const discoveries = new Map<
    string,
    {
      owner: string;
      connectorId: string;
      recipe: OAuthRecipe;
      expiresAt: number;
    }
  >();
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
  const failedRenewals = new Map<string, number>();
  const own = (id: string, owner: string) => {
    const entry = jobs.get(id);
    if (!entry || entry.owner !== owner)
      throw new HubError('not_found', 'Authentication job not found.');
    return entry;
  };
  return {
    healthRefreshFailed: (id: string, revision: number) =>
      failedRenewals.get(id) === revision,
    credentials,
    async discover(connectorId: string, raw: unknown, owner: string) {
      const input = OAuthDiscoverySchema.parse(raw);
      await safety.assertWritable();
      const state = await store.read(),
        connector = requireConnector(state, connectorId);
      if (
        closed ||
        state.revision !== input.expectedRevision ||
        !sameDefinition(
          connector,
          input.expectedConnectorRevision,
          input.definitionHash,
        )
      )
        throw new HubError(
          'conflict',
          'Approve a fresh enabled definition before OAuth discovery.',
        );
      if (connector.executionMode !== 'remote')
        throw new HubError('invalid', 'OAuth requires a remote connector.');
      const { recipe, discoveryHash } = await discovery(
        connector.endpoint,
        AbortSignal.timeout(10_000),
      );
      for (const [key, item] of discoveries)
        if (item.expiresAt <= now()) discoveries.delete(key);
      if (discoveries.size >= 50)
        throw new HubError('busy', 'OAuth discovery capacity reached.');
      discoveries.set(`${owner}:${connectorId}:${discoveryHash}`, {
        owner,
        connectorId,
        recipe,
        expiresAt: now() + 300_000,
      });
      return {
        recipeId: 'generic',
        discoveryHash,
        issuer: recipe.issuer,
        resource: recipe.resource,
        scopes: recipe.scopes,
        revocationSupported: !!recipe.revocation,
      };
    },
    async accounts() {
      const state = await store.read(),
        accounts = [];
      for (const connector of state.connectors) {
        const ref = state.secretReferences.find(
          (ref) =>
            ref.id === connector.headerBindings.Authorization &&
            ref.kind === 'oauth' &&
            ref.adapter === 'windows' &&
            ref.present,
        );
        if (!ref || !credentials.backends.windows?.read) continue;
        const bytes = await credentials.backends.windows.read(
          ref.id,
          AbortSignal.timeout(10_000),
        );
        try {
          const bundle = JSON.parse(bytes.toString('utf8')) as TokenBundle;
          const recipe =
            bundle.recipe ??
            recipes.find((recipe) => recipe.id === ref.recipeId);
          accounts.push({
            connectorId: connector.id,
            credentialId: ref.id,
            recipeId: ref.recipeId,
            issuer: recipe?.issuer ?? null,
            resource: recipe?.resource ?? null,
            scopes: recipe?.scopes ?? [],
            expiresAt: bundle.expiresAt,
            refreshSupported: !!bundle.refreshToken,
            revocationSupported: !!recipe?.revocation,
          });
        } finally {
          bytes.fill(0);
        }
      }
      return { revision: state.revision, accounts };
    },
    async disconnect(connectorId: string, raw: unknown) {
      const input = OAuthDisconnectSchema.parse(raw);
      await safety.assertWritable();
      const state = await store.read(),
        connector = requireConnector(state, connectorId);
      if (
        state.revision !== input.expectedRevision ||
        connector.revision !== input.expectedConnectorRevision
      )
        throw new HubError('conflict', 'Account inventory changed.');
      const ref = state.secretReferences.find(
        (ref) =>
          ref.id === connector.headerBindings.Authorization &&
          ref.kind === 'oauth',
      );
      const backend = credentials.backends.windows;
      if (!ref || ref.adapter !== 'windows' || !backend?.read || !backend.lock)
        throw new HubError(
          'unavailable',
          'Protected OAuth account is unavailable.',
        );
      if (
        ref.ownerIds.some((owner) => owner !== connectorId) ||
        state.connectors.some(
          (item) =>
            item.id !== connectorId &&
            [
              ...Object.values(item.headerBindings),
              ...Object.values(item.secretBindings),
            ].includes(ref.id),
        ) ||
        state.materializations?.some((item) =>
          item.secretReferenceIds?.includes(ref.id),
        )
      )
        throw new HubError(
          'conflict',
          'Remove other credential consumers before revoking this account.',
        );
      for (const entry of jobs.values())
        if (entry.job.connectorId === connectorId && !entry.job.completedAt)
          entry.controller.abort();
      const signal = AbortSignal.timeout(30_000),
        release = await backend.lock(ref.id, signal);
      let bytes: Buffer | undefined;
      try {
        // Recheck after waiting for a refresh in another process.
        const current = await store.read();
        if (current.revision !== input.expectedRevision)
          throw new HubError('conflict', 'Account inventory changed.');
        bytes = await backend.read(ref.id, signal);
        const bundle = JSON.parse(bytes.toString('utf8')) as TokenBundle;
        const recipe =
          bundle.recipe ?? recipes.find((recipe) => recipe.id === ref.recipeId);
        const providerRevoked =
          input.revokeProvider && recipe
            ? await revokeOAuth(recipe, bytes, signal)
            : false;
        const result = await credentials.disconnectOAuth(
          connectorId,
          input.expectedRevision,
          input.expectedConnectorRevision,
        );
        return {
          ...result,
          providerRevoked,
          providerActionRequired: !providerRevoked,
        };
      } finally {
        bytes?.fill(0);
        await release();
      }
    },
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
        nativeAdapter: credentials.nativeAdapter(),
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
              credentials.nativeAdapter() === 'windows' &&
              recipe.endpoint === connector.endpoint,
          )
          .map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            scopes: recipe.scopes,
            issuer: recipe.issuer,
            revocationSupported: !!recipe.revocation,
          })),
        state:
          (await checks.observations()).find(
            (observation) => observation.connectorId === id,
          )?.state ?? 'untested',
        localDeletionRevokesProvider: false,
        genericOAuthSupported:
          connector.executionMode === 'remote' &&
          credentials.nativeAdapter() === 'windows',
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
      let recipe = recipes.find(
        (recipe) =>
          recipe.id === input.recipeId &&
          connector.executionMode === 'remote' &&
          recipe.endpoint === connector.endpoint,
      );
      if (!recipe && input.recipeId === 'generic' && !refresh) {
        const discovered = discoveries.get(
          `${owner}:${connectorId}:${input.discoveryHash}`,
        );
        if (
          !discovered ||
          discovered.expiresAt <= now() ||
          !input.scopes ||
          (discovered.recipe.scopes.length &&
            input.scopes.some(
              (scope) => !discovered.recipe.scopes.includes(scope),
            ))
        )
          throw new HubError(
            'invalid',
            'Discover and approve the issuer and explicit scopes before sign-in.',
          );
        recipe = { ...discovered.recipe, scopes: [...new Set(input.scopes)] };
      }
      if (!recipe && input.recipeId === 'generic' && refresh) {
        const ref = state.secretReferences.find(
          (ref) =>
            ref.id === connector.headerBindings.Authorization &&
            ref.kind === 'oauth' &&
            ref.recipeId === 'generic',
        );
        if (ref) {
          const bytes = await credentials.backends.windows!.read!(
            ref.id,
            AbortSignal.timeout(10_000),
          );
          try {
            recipe = (JSON.parse(bytes.toString('utf8')) as TokenBundle).recipe;
          } finally {
            bytes.fill(0);
          }
        }
      }
      if (!recipe)
        throw new HubError(
          'unavailable',
          'This endpoint has no verified supported OAuth recipe.',
        );
      if (
        recipe.endpoint !==
        (connector.executionMode === 'remote' ? connector.endpoint : '')
      )
        throw new HubError('invalid', 'OAuth resource binding changed.');
      const selectedRecipe = recipe;
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
        let release: (() => Promise<void>) | undefined;
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
            release = await credentials.backends.windows!.lock?.(
              reference.id,
              controller.signal,
            );
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
            if (selectedRecipe.discovered) {
              const discovered = await discovery(
                selectedRecipe.endpoint,
                controller.signal,
              );
              if (
                discovered.discoveryHash !== input.discoveryHash ||
                hashData(discovered.recipe) !== input.discoveryHash
              )
                throw new AuthFault('definition_changed');
            }
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
          failedRenewals.delete(connectorId);
        } catch (error) {
          if (
            refresh &&
            error instanceof AuthFault &&
            [
              'refresh_failed',
              'expired',
              'auth_required',
              'unsupported',
            ].includes(error.reason)
          ) {
            if (failedRenewals.size >= 256)
              failedRenewals.delete(failedRenewals.keys().next().value!);
            failedRenewals.set(connectorId, connector.revision);
          }
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
          try {
            await release?.();
          } catch {
            job.state = 'failed';
            job.reason = 'recovery_required';
          } finally {
            job.authorizationUrl = null;
            job.completedAt = new Date(now()).toISOString();
          }
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
      for (const [key, item] of discoveries)
        if (item.owner === owner) discoveries.delete(key);
      for (const entry of jobs.values())
        if (entry.owner === owner && !entry.job.completedAt)
          entry.controller.abort();
    },
    async drain() {
      await Promise.all([...jobs.values()].map((entry) => entry.task));
    },
    async close() {
      failedRenewals.clear();
      closed = true;
      discoveries.clear();
      for (const entry of jobs.values()) entry.controller.abort();
      await Promise.all([...jobs.values()].map((entry) => entry.task));
    },
  };
}
