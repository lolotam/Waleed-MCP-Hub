import { createHash, randomUUID } from 'node:crypto';
import {
  RefusalInputSchema,
  JournalEntrySchema,
  SafetyStateSchema,
  StateSchema,
  type SafetyState,
  type JournalEntry,
  type HubState,
} from '@waleed/contracts';
import { HubError } from './errors.js';

export interface SafetyPersistence {
  assertUnchanged(): Promise<void>;
  save(next: SafetyState): Promise<void>;
  close(): Promise<void>;
}

export function stateHash(state: HubState): string {
  return createHash('sha256')
    .update(JSON.stringify(StateSchema.parse(state)))
    .digest('hex');
}

export const emptySafetyState = (): SafetyState => ({
  schemaVersion: 1,
  revision: 0,
  securityEvents: [],
  operations: [],
});
const unresolved = (entry: JournalEntry) =>
  entry.phase === 'prepared' || entry.phase === 'needs_review';

export function createSafetyLedger(
  initial: SafetyState,
  persistence: SafetyPersistence,
  now: () => number = Date.now,
) {
  let state = SafetyStateSchema.parse(initial);
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  let closing = false;
  const timestamp = () => new Date(now()).toISOString();
  function mutate(change: (next: SafetyState) => void): Promise<void> {
    if (closing)
      return Promise.reject(
        new HubError('unavailable', 'Safety ledger is closed.'),
      );
    if (queued >= 32)
      return Promise.reject(
        new HubError('busy', 'Safety ledger queue is full.'),
      );
    queued++;
    const task = tail
      .then(async () => {
        await persistence.assertUnchanged();
        const next = structuredClone(state);
        change(next);
        next.revision++;
        const checked = SafetyStateSchema.safeParse(next);
        if (!checked.success)
          throw new HubError('invalid', 'Safety metadata is invalid.');
        await persistence.save(checked.data);
        state = checked.data;
      })
      .finally(() => {
        queued--;
      });
    tail = task.catch(() => undefined);
    return task;
  }
  async function read(): Promise<SafetyState> {
    if (closing) throw new HubError('unavailable', 'Safety ledger is closed.');
    await tail;
    await persistence.assertUnchanged();
    return structuredClone(state);
  }
  return {
    read,
    async assertWritable() {
      if ((await read()).operations.some(unresolved))
        throw new HubError(
          'conflict',
          'An interrupted operation needs recovery review.',
        );
    },
    recordRefusal(raw: unknown): Promise<void> {
      const parsed = RefusalInputSchema.safeParse(raw);
      if (!parsed.success)
        return Promise.reject(
          new HubError(
            'invalid',
            'Only closed refusal metadata can be recorded.',
          ),
        );
      return mutate((next) => {
        next.securityEvents.push({
          ...parsed.data,
          id: randomUUID(),
          time: timestamp(),
        });
        next.securityEvents = next.securityEvents.slice(-200);
      });
    },
    prepare(raw: JournalEntry): Promise<void> {
      const parsed = JournalEntrySchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.phase !== 'prepared' ||
        parsed.data.reason !== 'none'
      )
        return Promise.reject(
          new HubError('invalid', 'Journal preparation metadata is invalid.'),
        );
      const entry = parsed.data;
      return mutate((next) => {
        if (next.operations.some(unresolved))
          throw new HubError(
            'conflict',
            'Recovery review is required before another mutation.',
          );
        if (next.operations.some((operation) => operation.id === entry.id))
          throw new HubError('conflict', 'Operation is already journaled.');
        // Never evict a record that still needs recovery.
        while (next.operations.length >= 100) {
          const index = next.operations.findIndex(
            (operation) => !unresolved(operation),
          );
          if (index < 0)
            throw new HubError('busy', 'Journal has no safe retention slot.');
          next.operations.splice(index, 1);
        }
        next.operations.push(entry);
      });
    },
    finish(
      id: string,
      phase: 'committed' | 'aborted' | 'needs_review',
      reason: JournalEntry['reason'] = 'none',
    ): Promise<void> {
      return mutate((next) => {
        const entry = next.operations.find((operation) => operation.id === id);
        if (!entry || entry.phase !== 'prepared')
          throw new HubError(
            'conflict',
            'Only a prepared operation can be finalized.',
          );
        entry.phase = phase;
        entry.reason = reason;
        entry.updatedAt = timestamp();
      });
    },
    async reconcile(current: HubState) {
      const hash = stateHash(current);
      if (!(await read()).operations.some(unresolved)) return;
      await mutate((next) => {
        for (const entry of next.operations.filter(unresolved)) {
          if (entry.external) {
            entry.phase = 'needs_review';
            entry.reason = 'state_drift';
          } else if (hash === entry.afterHash) {
            entry.phase = 'committed';
            entry.reason = 'interrupted_after_commit';
          } else if (hash === entry.beforeHash) {
            entry.phase = 'aborted';
            entry.reason = 'interrupted_before_commit';
          } else {
            entry.phase = 'needs_review';
            entry.reason = 'state_drift';
          }
          entry.updatedAt = timestamp();
        }
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      await tail;
      await persistence.close();
    },
  };
}

export function createMemorySafetyLedger(now: () => number = Date.now) {
  return createSafetyLedger(
    emptySafetyState(),
    { async assertUnchanged() {}, async save() {}, async close() {} },
    now,
  );
}
export type SafetyLedger = ReturnType<typeof createSafetyLedger>;
