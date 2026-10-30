import type { Connector, HubState } from '@waleed/contracts';
import { sameDefinition } from './credentials.js';
import { definitionHash } from '../runtime/registry.js';
import type { SecretBackends } from './secrets.js';
import {
  AuthFault,
  refreshOAuth,
  supportedOAuthRecipes,
  validateRecipe,
  type TokenBundle,
} from './oauth-flow.js';

// A refresh is not a tool retry. Run it before sending any MCP request, under a
// vault lock shared by all Hub/bridge processes using this account reference.
export function createOAuthTokenManager(
  backends: SecretBackends,
  read: () => Promise<HubState>,
  now: () => number = Date.now,
) {
  return async (connector: Connector, signal: AbortSignal) => {
    if (connector.executionMode !== 'remote') return;
    const id = connector.headerBindings.Authorization;
    if (!id) return;
    const state = await read();
    const reference = state.secretReferences.find(
      (ref) => ref.id === id && ref.kind === 'oauth',
    );
    if (!reference) return;
    const backend = backends.windows;
    if (reference.adapter !== 'windows' || !backend?.read)
      throw new AuthFault('dependency_unavailable');
    let release: (() => Promise<void>) | undefined;
    let previous: Buffer | undefined, value: Buffer | undefined;
    const current = async () => {
      const state = await read();
      const item = state.connectors.find((item) => item.id === connector.id);
      const ref = state.secretReferences.find((ref) => ref.id === id);
      if (
        !item ||
        !sameDefinition(item, connector.revision, definitionHash(connector)) ||
        !ref?.present ||
        !ref.ownerIds.includes(connector.id)
      )
        throw new AuthFault('definition_changed');
    };
    try {
      await current();
      previous = await backend.read(id, signal);
      let bundle = JSON.parse(previous.toString('utf8')) as TokenBundle;
      if (
        bundle.expiresAt === null ||
        (typeof bundle.expiresAt === 'number' &&
          bundle.expiresAt > now() + 30_000)
      )
        return;
      if (!backend.lock || !backend.replace)
        throw new AuthFault('refresh_failed');
      previous.fill(0);
      previous = undefined;
      release = await backend.lock(id, signal);
      await current();
      previous = await backend.read(id, signal);
      bundle = JSON.parse(previous.toString('utf8')) as TokenBundle;
      // A different process may already have refreshed while we waited.
      if (
        bundle.expiresAt === null ||
        (typeof bundle.expiresAt === 'number' &&
          bundle.expiresAt > now() + 30_000)
      )
        return;
      const recipe =
        bundle.recipe ??
        supportedOAuthRecipes.find(
          (recipe) => recipe.id === reference.recipeId,
        );
      if (!recipe || recipe.endpoint !== connector.endpoint)
        throw new AuthFault('unsupported');
      validateRecipe(recipe);
      value = await refreshOAuth(recipe, previous, signal, now);
      await current();
      signal.throwIfAborted();
      await backend.replace(id, value, signal);
    } finally {
      previous?.fill(0);
      value?.fill(0);
      await release?.();
    }
  };
}
