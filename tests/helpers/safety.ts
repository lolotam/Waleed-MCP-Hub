import { randomUUID } from 'node:crypto';
import {
  createSafetyLedger,
  emptySafetyState,
  emptyState,
  stateHash,
  type SafetyLedger,
} from '@waleed/hub-core';
import type { JournalEntry, SafetyState } from '@waleed/contracts';

export function journalFixture(): JournalEntry {
  return {
    id: randomUUID(),
    operation: 'create_profile',
    targetId: randomUUID(),
    expectedRevision: 0,
    beforeHash: stateHash(emptyState()),
    afterHash: 'a'.repeat(64),
    phase: 'prepared',
    reason: 'none',
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

export function failingFinalization(): {
  ledger: SafetyLedger;
  persisted: () => SafetyState;
  allow: () => void;
} {
  let saved = emptySafetyState();
  let fail = true;
  const ledger = createSafetyLedger(saved, {
    async assertUnchanged() {},
    async save(next) {
      if (fail && next.operations.some((entry) => entry.phase === 'committed'))
        throw new Error('Synthetic finalization failure');
      saved = structuredClone(next);
    },
    async close() {},
  });
  return {
    ledger,
    persisted: () => structuredClone(saved),
    allow: () => {
      fail = false;
    },
  };
}
