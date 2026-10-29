import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  RuntimeFault,
  type CapabilityRuntime,
} from '@waleed/hub-core';
import { profileState, definition } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';

const capabilities = {
  protocolVersion: '2025-11-25',
  tools: [{ name: 'fixture_tool', role: 'upstream' as const }],
  resourceCount: 0,
  promptCount: 0,
};
afterEach(() => vi.useRealTimers());
describe('approved capability jobs and isolated observations', () => {
  it('requires enabled, revision/hash-bound approval; secret-backed and absent adapters fail without execution', async () => {
    const state = profileState(['native']);
    const runtime: CapabilityRuntime = {
      discover: vi.fn(async () => capabilities),
    };
    const store = memoryStore(state);
    const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      runtime,
    });
    const edited = await store.read();
    edited.connectors[0]!.trustApproval = null;
    await store.write(0, edited);
    await expect(
      hub.checks.start('connector-0', 'owner'),
    ).rejects.toMatchObject({ code: 'conflict' });
    edited.connectors[0]!.enabled = false;
    await store.write(0, edited);
    await expect(
      hub.checks.start('connector-0', 'owner'),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(runtime.discover).not.toHaveBeenCalled();
    const unavailable = createLifecycle(memoryStore(state));
    await expect(
      unavailable.checks.start('connector-0', 'owner'),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const secret = profileState(['native']);
    secret.connectors[0]!.secretBindings = { KEY: 'reference' };
    const { definitionHash } = await import('@waleed/hub-core');
    secret.connectors[0]!.trustApproval!.definitionHash = definitionHash(
      secret.connectors[0]!,
    );
    await expect(
      createLifecycle(
        memoryStore(secret),
        Date.now,
        createMemorySafetyLedger(),
        { runtime },
      ).checks.start('connector-0', 'owner'),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('retains a healthy connector observation when a different connector fails authentication', async () => {
    const state = profileState(['remote', 'remote']);
    const runtime: CapabilityRuntime = {
      async discover(connector) {
        if (connector.id === 'connector-1')
          throw new RuntimeFault('auth_required');
        return capabilities;
      },
    };
    const hub = createLifecycle(
      memoryStore(state),
      Date.now,
      createMemorySafetyLedger(),
      { runtime },
    );
    const healthy = await hub.checks.start('connector-0', 'owner');
    await hub.checks.drain();
    const before = (await hub.checks.observations())[0];
    const failed = await hub.checks.start('connector-1', 'owner');
    await hub.checks.drain();
    expect(hub.checks.job(healthy.id, 'owner').state).toBe('succeeded');
    expect(hub.checks.job(failed.id, 'owner').reason).toBe('auth_required');
    expect((await hub.checks.observations())[0]).toEqual(before);
    expect((await hub.checks.observations())[1]?.state).toBe('auth_required');
    await hub.close();
  });
  it('scopes cancellation and job reads, bounds concurrency, and stops changed definitions without publishing stale health', async () => {
    const state = profileState(['native', 'native', 'native']);
    const runtime: CapabilityRuntime = {
      async discover(_connector, signal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new RuntimeFault('cancelled');
      },
    };
    const hub = createLifecycle(
      memoryStore(state),
      Date.now,
      createMemorySafetyLedger(),
      { runtime },
    );
    const first = await hub.checks.start('connector-0', 'owner');
    const second = await hub.checks.start('connector-1', 'owner');
    await expect(
      hub.checks.start('connector-2', 'owner'),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(() => hub.checks.cancel(first.id, 'other')).toThrow();
    expect(() => hub.checks.job(first.id, 'other')).toThrow();
    const preview = await hub.preview(
      {
        kind: 'edit_connector',
        expectedRevision: 0,
        connectorId: 'connector-0',
        definition: definition({
          id: 'connector-0',
          name: 'Edited',
          command: 'C:\\Synthetic\\node.exe',
          args: ['different.js'],
        }),
      },
      'owner',
    );
    const mutation = await hub.apply(preview.id, 'owner');
    hub.checks.cancel(second.id, 'owner');
    await hub.drain();
    expect(hub.job(mutation.id, 'owner').state).toBe('succeeded');
    expect(hub.checks.job(first.id, 'owner').reason).toBe('definition_changed');
    expect(
      (await hub.checks.observations()).find(
        (item) => item.connectorId === 'connector-0',
      ),
    ).toMatchObject({
      revision: 2,
      state: 'untested',
      reason: 'approval_required',
    });
    await hub.close();
  });
  it('bounds stalled checks by deadline and never claims success on cancellation', async () => {
    vi.useFakeTimers();
    const runtime: CapabilityRuntime = {
      async discover(_connector, signal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new RuntimeFault('cancelled');
      },
    };
    const hub = createLifecycle(
      memoryStore(profileState(['native'])),
      Date.now,
      createMemorySafetyLedger(),
      { runtime },
    );
    const job = await hub.checks.start('connector-0', 'owner');
    await vi.advanceTimersByTimeAsync(20_001);
    await hub.checks.drain();
    expect(hub.checks.job(job.id, 'owner')).toMatchObject({
      state: 'failed',
      reason: 'timed_out',
    });
    await hub.close();
  });
  it('journals owned-container cleanup and blocks recovery when cleanup is uncertain', async () => {
    const ledger = createMemorySafetyLedger();
    const hub = createLifecycle(
      memoryStore(profileState(['docker'])),
      Date.now,
      ledger,
      {
        runtime: {
          async discover() {
            throw new RuntimeFault('dependency_unavailable', true);
          },
        },
      },
    );
    const job = await hub.checks.start('connector-0', 'owner');
    await hub.checks.drain();
    expect(hub.checks.job(job.id, 'owner').state).toBe('failed');
    expect((await ledger.read()).operations[0]?.phase).toBe('needs_review');
    await expect(
      hub.preview(
        {
          kind: 'remove_connector',
          expectedRevision: 0,
          connectorId: 'connector-0',
        },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await hub.close();
  });
});
