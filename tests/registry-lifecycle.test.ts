import { describe, expect, it } from 'vitest';
import {
  approved,
  definitionHash,
  createLifecycle,
  createMemorySafetyLedger,
} from '@waleed/hub-core';
import {
  apply,
  connector,
  definition,
  profileState,
  setupRegistry,
} from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';

describe('P5 registry lifecycle', () => {
  it('creates, edits, disables, enables and removes connectors only through preview/apply', async () => {
    const { hub } = setupRegistry();
    const initial = definition({
      id: 'native',
      name: 'Native',
      command: 'npx',
      args: ['-y', 'synthetic@1.2.3'],
    });
    const preview = await hub.preview(
      { kind: 'create_connector', expectedRevision: 0, definition: initial },
      'owner',
    );
    expect((await hub.inventory()).connectors).toEqual([]);
    const job = await hub.apply(preview.id, 'owner');
    await hub.drain();
    expect(hub.job(job.id, 'owner').state).toBe('succeeded');
    let saved = (await hub.inventory()).connectors[0]!;
    expect(saved.trustApproval).toBeNull();
    expect(
      (
        await apply(hub, {
          kind: 'approve_connector',
          connectorId: saved.id,
          expectedConnectorRevision: saved.revision,
          definitionHash: definitionHash(saved),
          approveExecution: true,
        })
      ).state,
    ).toBe('succeeded');
    expect(approved((await hub.inventory()).connectors[0]!)).toBe(true);
    expect(
      (
        await apply(hub, {
          kind: 'edit_connector',
          connectorId: 'native',
          definition: { ...initial, arguments: ['-y', 'synthetic@2.0.0'] },
        })
      ).state,
    ).toBe('succeeded');
    saved = (await hub.inventory()).connectors[0]!;
    expect(saved.revision).toBe(2);
    expect(saved.trustApproval).toBeNull();
    await apply(hub, {
      kind: 'set_connector_enabled',
      connectorId: 'native',
      enabled: false,
    });
    expect((await hub.inventory()).connectors[0]!.enabled).toBe(false);
    await apply(hub, {
      kind: 'set_connector_enabled',
      connectorId: 'native',
      enabled: true,
    });
    await apply(hub, { kind: 'remove_connector', connectorId: 'native' });
    expect((await hub.inventory()).connectors).toEqual([]);
    expect(JSON.stringify((await hub.inventory()).activity)).not.toContain(
      'synthetic@',
    );
  });
  it('creates/edits profiles, assigns/unassigns separately, and never removes a connector when unassigning', async () => {
    const { hub } = setupRegistry(profileState());
    await apply(hub, {
      kind: 'unassign_connector',
      profileId: 'profile',
      connectorId: 'connector-0',
    });
    expect((await hub.inventory()).connectors).toHaveLength(2);
    expect((await hub.inventory()).profiles[0]!.connectorIds).toEqual([
      'connector-1',
    ]);
    await apply(hub, {
      kind: 'assign_connector',
      profileId: 'profile',
      connectorId: 'connector-0',
    });
    await apply(hub, {
      kind: 'edit_profile',
      profileId: 'profile',
      name: 'Edited',
      description: 'Synthetic',
      connectorIds: ['connector-0'],
      enabled: true,
    });
    await apply(hub, {
      kind: 'set_profile_enabled',
      profileId: 'profile',
      enabled: false,
    });
    expect((await hub.inventory()).profiles[0]!.enabled).toBe(false);
    await apply(hub, { kind: 'remove_profile', profileId: 'profile' });
    expect((await hub.inventory()).profiles).toEqual([]);
    expect((await hub.inventory()).connectors).toHaveLength(2);
  });
  it('detects duplicate names/IDs, invalid memberships, invalid consent and stale approval hashes', async () => {
    const { hub } = setupRegistry(profileState());
    for (const input of [
      {
        kind: 'create_connector',
        definition: definition({
          id: 'other',
          name: 'CONNECTOR-0',
          command: 'tool',
        }),
      },
      {
        kind: 'create_connector',
        definition: definition({
          id: 'connector-0',
          name: 'Other',
          command: 'tool',
        }),
      },
      {
        kind: 'assign_connector',
        profileId: 'profile',
        connectorId: 'missing',
      },
      {
        kind: 'approve_connector',
        connectorId: 'connector-0',
        expectedConnectorRevision: 999,
        definitionHash: 'a'.repeat(64),
        approveExecution: true,
      },
      {
        kind: 'approve_connector',
        connectorId: 'connector-0',
        expectedConnectorRevision: 1,
        definitionHash: definitionHash((await hub.inventory()).connectors[0]!),
        approveExecution: false,
      },
      {
        kind: 'edit_connector',
        connectorId: 'connector-0',
        definition: definition({ id: 'new-id', command: 'tool' }),
      },
    ])
      await expect(
        hub.preview({ expectedRevision: 0, ...input }, 'owner'),
      ).rejects.toBeDefined();
    expect((await hub.inventory()).revision).toBe(0);
  });
  it('validates a batch atomically and rejects private draft references and unsafe literal environments', async () => {
    const { hub } = setupRegistry();
    const item = definition({ id: 'test', command: 'tool' });
    await expect(
      hub.preview(
        {
          kind: 'create_connectors',
          expectedRevision: 0,
          definitions: [item, item],
        },
        'owner',
      ),
    ).rejects.toBeDefined();
    await expect(
      hub.preview(
        {
          kind: 'create_connector',
          expectedRevision: 0,
          definition: {
            ...item,
            secretBindings: { KEY: 'draft-entry-1-environment-1' },
          },
        },
        'owner',
      ),
    ).rejects.toBeDefined();
    await expect(
      hub.preview(
        {
          kind: 'create_connector',
          expectedRevision: 0,
          definition: {
            ...item,
            environmentLiterals: { NODE_OPTIONS: '--require untrusted' },
          },
        },
        'owner',
      ),
    ).rejects.toBeDefined();
    expect((await hub.inventory()).connectors).toEqual([]);
  });
  it('disabling and unassigning retain shared credentials; removal never deletes a secret store value', async () => {
    const state = profileState();
    state.connectors[0]!.headerBindings = { Authorization: 'shared' };
    state.connectors[1]!.secretBindings = { TOKEN: 'shared' };
    state.secretReferences.push({
      id: 'shared',
      adapter: 'docker',
      present: true,
      ownerIds: ['connector-0', 'connector-1', 'independent-owner'],
    });
    const { hub } = setupRegistry(state);
    await apply(hub, {
      kind: 'set_connector_enabled',
      connectorId: 'connector-0',
      enabled: false,
    });
    await apply(hub, {
      kind: 'unassign_connector',
      connectorId: 'connector-1',
      profileId: 'profile',
    });
    expect((await hub.inventory()).secretReferences[0]).toMatchObject({
      present: true,
      ownerIds: ['connector-1', 'independent-owner', 'connector-0'],
    });
    await apply(hub, { kind: 'remove_connector', connectorId: 'connector-0' });
    expect((await hub.inventory()).secretReferences[0]).toMatchObject({
      present: true,
      ownerIds: ['connector-1', 'independent-owner'],
    });
    expect((await hub.inventory()).profiles[0]!.connectorIds).toEqual([]);
  });
  it('marks only existing affected agent bindings reconnect-required; no agent configuration write occurs', async () => {
    const state = profileState();
    state.profiles.push({
      ...state.profiles[0]!,
      id: 'other',
      connectorIds: [],
    });
    state.agentBindings = [
      {
        agentId: 'opencode',
        profileId: 'profile',
        appliedRevision: 1,
        reconnectRequired: false,
      },
      {
        agentId: 'codex',
        profileId: 'other',
        appliedRevision: 1,
        reconnectRequired: false,
      },
    ];
    const { hub } = setupRegistry(state);
    const job = await apply(hub, {
      kind: 'set_connector_enabled',
      connectorId: 'connector-0',
      enabled: false,
    });
    expect(job.state).toBe('succeeded');
    expect(
      (await hub.inventory()).agentBindings?.map(
        (binding) => binding.reconnectRequired,
      ),
    ).toEqual([true, false]);
  });
  it('keeps interrupted external checkpoints blocked even when the registry hash looks committed', async () => {
    const store = memoryStore();
    const safety = createMemorySafetyLedger();
    const hub = createLifecycle(store, Date.now, safety);
    const item = connector();
    const state = await store.read();
    const { stateHash } = await import('@waleed/hub-core');
    await safety.prepare({
      id: crypto.randomUUID(),
      operation: 'materialize_profile',
      targetId: item.id,
      expectedRevision: 0,
      beforeHash: 'a'.repeat(64),
      afterHash: stateHash(state),
      phase: 'prepared',
      reason: 'none',
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      external: true,
    });
    await safety.reconcile(state);
    expect((await safety.read()).operations[0]?.phase).toBe('needs_review');
    await expect(
      hub.preview(
        {
          kind: 'create_profile',
          name: 'Blocked',
          description: '',
          expectedRevision: 0,
        },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
