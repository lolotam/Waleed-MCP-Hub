import { describe, expect, it } from 'vitest';
import {
  createMemorySafetyLedger,
  createSafetyLedger,
  emptySafetyState,
  emptyState,
  stateHash,
} from '@waleed/hub-core';
import { journalFixture } from './helpers/safety.js';

const refusal = {
  reason: 'csrf_required',
  route: 'preview',
  method: 'POST',
  status: 403,
};

describe('bounded safety metadata', () => {
  it('accepts only closed metadata and retains the latest 200 refusals', async () => {
    const ledger = createMemorySafetyLedger();
    await expect(
      ledger.recordRefusal({ ...refusal, body: 'SYNTHETIC-SENSITIVE-PAYLOAD' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      ledger.recordRefusal({
        ...refusal,
        reason: 'SYNTHETIC-SENSITIVE-PAYLOAD',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    for (let index = 0; index < 205; index++)
      await ledger.recordRefusal(refusal);
    const snapshot = await ledger.read();
    expect(snapshot.securityEvents).toHaveLength(200);
    expect(JSON.stringify(snapshot)).not.toContain(
      'SYNTHETIC-SENSITIVE-PAYLOAD',
    );
    snapshot.securityEvents.length = 0;
    expect((await ledger.read()).securityEvents).toHaveLength(200);
    await ledger.close();
  });
  it('bounds queued writes and drains accepted writes on close', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saves = 0;
    const ledger = createSafetyLedger(emptySafetyState(), {
      async assertUnchanged() {},
      async save() {
        await blocked;
        saves++;
      },
      async close() {},
    });
    const accepted = Array.from({ length: 32 }, () =>
      ledger.recordRefusal(refusal),
    );
    await expect(ledger.recordRefusal(refusal)).rejects.toMatchObject({
      code: 'busy',
    });
    const closing = ledger.close();
    await expect(ledger.recordRefusal(refusal)).rejects.toMatchObject({
      code: 'unavailable',
    });
    release();
    await Promise.all(accepted);
    await closing;
    expect(saves).toBe(32);
  });
  it('does not publish failed writes or poison later queued operations', async () => {
    let fail = true;
    const ledger = createSafetyLedger(emptySafetyState(), {
      async assertUnchanged() {},
      async save() {
        if (fail) throw new Error('synthetic failure');
      },
      async close() {},
    });
    await expect(ledger.recordRefusal(refusal)).rejects.toThrow();
    expect((await ledger.read()).securityEvents).toHaveLength(0);
    fail = false;
    await ledger.recordRefusal(refusal);
    expect((await ledger.read()).securityEvents).toHaveLength(1);
  });
});

describe('recovery journal', () => {
  it('blocks mutations for unfinished entries and classifies exact pre/post commit states', async () => {
    const ledger = createMemorySafetyLedger();
    const entry = journalFixture();
    await ledger.prepare(entry);
    await expect(ledger.assertWritable()).rejects.toMatchObject({
      code: 'conflict',
    });
    await ledger.reconcile(emptyState());
    expect((await ledger.read()).operations[0]).toMatchObject({
      phase: 'aborted',
      reason: 'interrupted_before_commit',
    });
    await ledger.assertWritable();
    const next = journalFixture();
    next.afterHash = stateHash({ ...emptyState(), revision: 1 });
    await ledger.prepare(next);
    await ledger.reconcile({ ...emptyState(), revision: 1 });
    expect((await ledger.read()).operations[1]).toMatchObject({
      phase: 'committed',
      reason: 'interrupted_after_commit',
    });
  });
  it('never assumes drift is safe or allows an unreviewed journal transition', async () => {
    const ledger = createMemorySafetyLedger();
    const entry = journalFixture();
    await ledger.prepare(entry);
    await ledger.reconcile({ ...emptyState(), revision: 55 });
    expect((await ledger.read()).operations[0]).toMatchObject({
      phase: 'needs_review',
      reason: 'state_drift',
    });
    await expect(ledger.assertWritable()).rejects.toThrow();
    await expect(ledger.finish(entry.id, 'committed')).rejects.toThrow();
    await expect(ledger.prepare(journalFixture())).rejects.toThrow();
  });
  it('retains 100 terminal operations without evicting an unfinished operation', async () => {
    const ledger = createMemorySafetyLedger();
    for (let index = 0; index < 105; index++) {
      const entry = journalFixture();
      await ledger.prepare(entry);
      await ledger.finish(entry.id, 'aborted', 'commit_failed');
    }
    expect((await ledger.read()).operations).toHaveLength(100);
    const pending = journalFixture();
    await ledger.prepare(pending);
    await expect(ledger.prepare(journalFixture())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await ledger.read()).operations.at(-1)?.id).toBe(pending.id);
  });
});
