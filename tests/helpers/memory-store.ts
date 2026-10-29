import type { HubState } from '@waleed/contracts';
import { HubError, emptyState, type StateStore } from '@waleed/hub-core';

export function memoryStore(initial: HubState = emptyState()): StateStore {
  let state = structuredClone(initial);
  return {
    async read() {
      return structuredClone(state);
    },
    async write(expectedRevision, next) {
      if (state.revision !== expectedRevision)
        throw new HubError('conflict', 'State revision changed.');
      state = structuredClone(next);
    },
    async close() {},
  };
}
