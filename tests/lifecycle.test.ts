import { describe, expect, it } from 'vitest';
import { createLifecycle } from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';

const input = {
  kind: 'create_profile',
  expectedRevision: 0,
  name: 'Synthetic workflow',
  description: '',
};

describe('local lifecycle', () => {
  it('previews without persistence, applies once, records only structural audit metadata', async () => {
    const hub = createLifecycle(memoryStore());
    const preview = await hub.preview(input, 'session-a');
    expect((await hub.inventory()).profiles).toHaveLength(0);
    const job = await hub.apply(preview.id, 'session-a');
    await hub.drain();
    expect(hub.job(job.id, 'session-a').state).toBe('succeeded');
    const state = await hub.inventory();
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]?.dockerProfileId).toBeNull();
    expect(JSON.stringify(state.activity)).not.toContain(input.name);
    await expect(hub.apply(preview.id, 'session-a')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
  it('enforces ownership, expiry, staleness, and duplicate names', async () => {
    let now = 0;
    const hub = createLifecycle(memoryStore(), () => now);
    const preview = await hub.preview(input, 'a');
    await expect(hub.apply(preview.id, 'b')).rejects.toMatchObject({
      code: 'not_found',
    });
    now += 5 * 60_000 + 1;
    await expect(hub.apply(preview.id, 'a')).rejects.toMatchObject({
      code: 'not_found',
    });
    const fresh = await hub.preview(input, 'a');
    const stale = await hub.preview({ ...input, name: 'Different' }, 'a');
    const job = await hub.apply(fresh.id, 'a');
    expect(() => hub.job(job.id, 'b')).toThrow();
    await hub.drain();
    await expect(hub.apply(stale.id, 'a')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      hub.preview({ ...input, expectedRevision: 1 }, 'a'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('cancels queued work without a write', async () => {
    const hub = createLifecycle(memoryStore());
    const preview = await hub.preview(input, 'a');
    const job = await hub.apply(preview.id, 'a');
    expect(hub.cancel(job.id, 'a').state).toBe('cancelled');
    await hub.drain();
    expect((await hub.inventory()).revision).toBe(0);
  });
  it('never stores arbitrary persistence exceptions in job diagnostics', async () => {
    const store = memoryStore();
    store.write = async () => {
      throw new Error('SYNTHETIC-SENSITIVE-ERROR');
    };
    const hub = createLifecycle(store);
    const preview = await hub.preview(input, 'a');
    const job = await hub.apply(preview.id, 'a');
    await hub.drain();
    expect(hub.job(job.id, 'a').state).toBe('failed');
    expect(JSON.stringify(hub.job(job.id, 'a'))).not.toContain(
      'SYNTHETIC-SENSITIVE-ERROR',
    );
  });
});
