import { expect, it, vi } from 'vitest';
import { createMemorySafetyLedger } from '@waleed/hub-core';
import { createRuntimeChecks } from '../packages/hub-core/src/runtime/checks.js';
import { memoryStore } from './helpers/memory-store.js';
import { profileState } from './helpers/runtime.js';

it('waits for a Docker check admitted during shutdown and finishes its journal before closing', async () => {
  const safety = createMemorySafetyLedger();
  const store = memoryStore(profileState(['docker']));
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ledger = {
    ...safety,
    async prepare(...args: Parameters<typeof safety.prepare>) {
      await safety.prepare(...args);
      entered();
      await gate;
    },
  };
  const discover = vi.fn();
  const checks = createRuntimeChecks(store, ledger, { discover });
  const started = checks.start('connector-0', 'owner');
  await ready;
  let closed = false;
  const closing = checks.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  const job = await started;
  await closing;
  expect(discover).not.toHaveBeenCalled();
  expect(checks.job(job.id, 'owner').state).toBe('cancelled');
  expect(
    (await safety.read()).operations.find(
      (operation) => operation.id === job.id,
    )?.phase,
  ).toBe('aborted');
  await safety.close();
  await store.close();
});
