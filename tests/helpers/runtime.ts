import type { ImportDefinition, Connector, HubState } from '@waleed/contracts';
import { createLifecycle, definitionHash, emptyState } from '@waleed/hub-core';
import {
  normalizeImport,
  clearImport,
} from '../../packages/hub-core/src/imports/normalize.js';
import { memoryStore } from './memory-store.js';

export function definition(source: unknown): ImportDefinition {
  const draft = normalizeImport(JSON.stringify(source));
  try {
    if (!draft.entries[0]?.definition)
      throw new Error('Invalid synthetic definition.');
    return structuredClone(draft.entries[0].definition);
  } finally {
    clearImport(draft);
  }
}
export function connector(
  id = 'synthetic',
  mode: 'native' | 'remote' | 'docker' = 'remote',
): Connector {
  const value = definition(
    mode === 'native'
      ? {
          id,
          name: id,
          command: 'C:\\Synthetic Space\\node.exe',
          args: ['fixture.js', 'عربي', '"quotes"', '$(inert)'],
        }
      : mode === 'docker'
        ? {
            id,
            name: id,
            image: 'synthetic-image:1.2.3',
            command: ['fixture'],
            args: ['--Case'],
          }
        : { id, name: id, url: 'https://example.test/mcp' },
  );
  const item = {
    ...value,
    revision: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  } as Connector;
  item.trustApproval = {
    revision: 1,
    approvedAt: item.createdAt,
    definitionHash: definitionHash(item),
    risk:
      mode === 'native'
        ? 'native_execution'
        : mode === 'docker'
          ? 'image_execution'
          : 'network',
  };
  return item;
}
export function profileState(
  modes: Array<'native' | 'remote' | 'docker'> = ['remote', 'docker'],
): HubState {
  const state = emptyState();
  state.connectors = modes.map((mode, index) =>
    connector(`connector-${index}`, mode),
  );
  state.profiles.push({
    id: 'profile',
    name: 'Synthetic profile',
    description: '',
    connectorIds: state.connectors.map((item) => item.id),
    revision: 1,
    dockerProfileId: null,
    updatedAt: '2026-10-28T00:00:00.000Z',
  });
  return state;
}
export async function apply(
  hub: ReturnType<typeof createLifecycle>,
  input: Record<string, unknown>,
) {
  const preview = await hub.preview(
    { expectedRevision: (await hub.inventory()).revision, ...input },
    'owner',
  );
  const job = await hub.apply(preview.id, 'owner');
  await hub.drain();
  return hub.job(job.id, 'owner');
}
export const setupRegistry = (state = emptyState()) => {
  const store = memoryStore(state);
  return { store, hub: createLifecycle(store) };
};
