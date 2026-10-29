import { describe, expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createSafetyLedger,
  emptySafetyState,
} from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';
import { failingFinalization } from './helpers/safety.js';

const input = {
  kind: 'create_profile',
  expectedRevision: 0,
  name: 'Synthetic workflow',
  description: 'Not an external profile.',
};

describe('journaled local lifecycle', () => {
  it('prepares before the state write and finalizes a successful commit without storing the raw input', async () => {
    const store = memoryStore();
    const ledger = createMemorySafetyLedger();
    const write = store.write;
    store.write = async (revision, state) => {
      expect((await ledger.read()).operations[0]?.phase).toBe('prepared');
      await write(revision, state);
    };
    const hub = createLifecycle(store, Date.now, ledger);
    const preview = await hub.preview(input, 'session');
    const job = await hub.apply(preview.id, 'session');
    await hub.drain();
    expect(hub.job(job.id, 'session').state).toBe('succeeded');
    expect((await ledger.read()).operations[0]).toMatchObject({
      id: job.id,
      phase: 'committed',
    });
    expect(JSON.stringify(await ledger.read())).not.toContain(input.name);
    expect(JSON.stringify(await ledger.read())).not.toContain(
      input.description,
    );
  });
  it('executes no state write if journal preparation fails', async () => {
    const ledger = createSafetyLedger(emptySafetyState(), {
      async assertUnchanged() {},
      async save() {
        throw new Error('SYNTHETIC-SENSITIVE-ERROR');
      },
      async close() {},
    });
    const store = memoryStore();
    let writes = 0;
    store.write = async () => {
      writes++;
    };
    const hub = createLifecycle(store, Date.now, ledger);
    const preview = await hub.preview(input, 'a');
    const job = await hub.apply(preview.id, 'a');
    await hub.drain();
    expect(writes).toBe(0);
    expect(hub.job(job.id, 'a').state).toBe('failed');
    expect(JSON.stringify(hub.job(job.id, 'a'))).not.toContain(
      'SYNTHETIC-SENSITIVE-ERROR',
    );
  });
  it('marks a proven pre-commit failure aborted and permits a fresh preview', async () => {
    const store = memoryStore();
    store.write = async () => {
      throw new Error('synthetic');
    };
    const ledger = createMemorySafetyLedger();
    const hub = createLifecycle(store, Date.now, ledger);
    const preview = await hub.preview(input, 'a');
    const job = await hub.apply(preview.id, 'a');
    await hub.drain();
    expect(hub.job(job.id, 'a').state).toBe('failed');
    expect((await ledger.read()).operations[0]).toMatchObject({
      phase: 'aborted',
      reason: 'commit_failed',
    });
    await expect(hub.preview(input, 'a')).resolves.toBeDefined();
  });
  it('does not call a completed registry commit failed when finalization fails', async () => {
    const store = memoryStore();
    const fault = failingFinalization();
    const hub = createLifecycle(store, Date.now, fault.ledger);
    const preview = await hub.preview(input, 'a');
    const job = await hub.apply(preview.id, 'a');
    await hub.drain();
    expect(hub.job(job.id, 'a')).toMatchObject({
      state: 'succeeded',
      reason: expect.stringContaining('Do not retry'),
    });
    expect((await store.read()).profiles).toHaveLength(1);
    expect(fault.persisted().operations[0]?.phase).toBe('prepared');
    await expect(
      hub.preview({ ...input, expectedRevision: 1, name: 'Second' }, 'a'),
    ).rejects.toMatchObject({ code: 'conflict' });
    fault.allow();
    await fault.ledger.reconcile(await store.read());
    expect((await fault.ledger.read()).operations[0]).toMatchObject({
      phase: 'committed',
      reason: 'interrupted_after_commit',
    });
    expect((await store.read()).profiles).toHaveLength(1);
  });
  it('confirms an ambiguous store error by read-back instead of replaying the operation', async () => {
    const store = memoryStore();
    const write = store.write;
    store.write = async (revision, next) => {
      await write(revision, next);
      throw new Error('synthetic post-commit error');
    };
    const ledger = createMemorySafetyLedger();
    const hub = createLifecycle(store, Date.now, ledger);
    const preview = await hub.preview(input, 'a');
    const job = await hub.apply(preview.id, 'a');
    await hub.drain();
    expect(hub.job(job.id, 'a').state).toBe('succeeded');
    expect((await ledger.read()).operations[0]?.phase).toBe('committed');
    expect((await store.read()).profiles).toHaveLength(1);
  });
  it('preserves uncertain external state and blocks further mutations rather than restoring an old snapshot', async () => {
    const store = memoryStore();
    const write = store.write;
    store.write = async (revision, next) => {
      const changed = structuredClone(next);
      changed.profiles[0]!.name = 'External synthetic edit';
      await write(revision, changed);
      throw new Error('synthetic drift');
    };
    const ledger = createMemorySafetyLedger();
    const hub = createLifecycle(store, Date.now, ledger);
    const preview = await hub.preview(input, 'a');
    const job = await hub.apply(preview.id, 'a');
    await hub.drain();
    expect(hub.job(job.id, 'a').state).toBe('failed');
    expect((await ledger.read()).operations[0]).toMatchObject({
      phase: 'needs_review',
      reason: 'state_drift',
    });
    expect((await store.read()).profiles[0]?.name).toBe(
      'External synthetic edit',
    );
    await expect(
      hub.preview({ ...input, expectedRevision: 1 }, 'a'),
    ).rejects.toThrow();
  });
});
