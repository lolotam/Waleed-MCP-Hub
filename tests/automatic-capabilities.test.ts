import { expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  RuntimeFault,
} from '@waleed/hub-core';
import { profileState } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
const result = {
  protocolVersion: '2025-11-25',
  tools: [{ name: 'read', role: 'upstream' as const }],
  resourceCount: 0,
  promptCount: 0,
};
it('automatically discovers approved connectors with two-job concurrency, deduplication and isolated failures', async () => {
  const state = profileState(
    Array.from({ length: 7 }, () => 'native' as const),
  );
  state.connectors[5]!.enabled = false;
  state.connectors[6]!.trustApproval = null;
  const called: string[] = [];
  const pending: Array<() => void> = [];
  let active = 0,
    peak = 0;
  const hub = createLifecycle(
    memoryStore(state),
    Date.now,
    createMemorySafetyLedger(),
    {
      runtime: {
        async discover(connector) {
          called.push(connector.id);
          peak = Math.max(peak, ++active);
          await new Promise<void>((resolve) => pending.push(resolve));
          active--;
          if (connector.id === 'connector-1')
            throw new RuntimeFault('auth_required');
          return result;
        },
      },
    },
  );
  try {
    await Promise.all([
      hub.checks.discoverApproved('owner'),
      hub.checks.discoverApproved('other'),
    ]);
    await expect.poll(() => called.length).toBe(2);
    expect(peak).toBe(2);
    pending.splice(0).forEach((fn) => fn());
    await expect.poll(() => called.length).toBe(4);
    pending.splice(0).forEach((fn) => fn());
    await expect.poll(() => called.length).toBe(5);
    pending.splice(0).forEach((fn) => fn());
    await expect.poll(() => hub.checks.discovering()).toBe(false);
    expect(new Set(called).size).toBe(5);
    expect(peak).toBe(2);
    const observed = await hub.checks.observations();
    expect(observed[0]!.state).toBe('connected');
    expect(observed[1]!.state).toBe('auth_required');
    await hub.checks.discoverApproved('owner');
    await expect.poll(() => hub.checks.discovering()).toBe(false);
    expect(called).toHaveLength(5);
  } finally {
    pending.splice(0).forEach((fn) => fn());
    await hub.close();
  }
});
it('cancels discovery on shutdown without starting queued work', async () => {
  const store = memoryStore(profileState(['native', 'native', 'native']));
  const calls: string[] = [];
  const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
    runtime: {
      async discover(connector, signal) {
        calls.push(connector.id);
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return result;
      },
    },
  });
  await hub.checks.discoverApproved('owner');
  await expect.poll(() => calls.length).toBe(2);
  await hub.close();
  expect(calls).toEqual(['connector-0', 'connector-1']);
  expect(hub.checks.discovering()).toBe(false);
  expect((await hub.checks.observations())[0]!.state).toBe('cancelled');
});

it('continues automatic discovery after Docker releases its prepared safety operation', async () => {
  const pending: Array<() => void> = [];
  const calls: string[] = [];
  const hub = createLifecycle(
    memoryStore(profileState(['docker', 'native', 'native'])),
    Date.now,
    createMemorySafetyLedger(),
    {
      runtime: {
        async discover(connector) {
          calls.push(connector.id);
          await new Promise<void>((resolve) => pending.push(resolve));
          return result;
        },
      },
    },
  );
  try {
    await hub.checks.discoverApproved('owner');
    await expect.poll(() => calls.length).toBe(1);
    pending.splice(0).forEach((resolve) => resolve());
    await expect.poll(() => calls.length).toBe(3);
    pending.splice(0).forEach((resolve) => resolve());
    await expect.poll(() => hub.checks.discovering()).toBe(false);
    expect((await hub.checks.observations()).map((item) => item.state)).toEqual(
      ['connected', 'connected', 'connected'],
    );
  } finally {
    pending.splice(0).forEach((resolve) => resolve());
    await hub.close();
  }
});

it('does not start a queued connector after its execution approval is revoked', async () => {
  const store = memoryStore(profileState(['native', 'native', 'native']));
  const pending: Array<() => void> = [];
  const called: string[] = [];
  const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
    runtime: {
      async discover(connector) {
        called.push(connector.id);
        await new Promise<void>((resolve) => pending.push(resolve));
        return result;
      },
    },
  });
  try {
    await hub.checks.discoverApproved('owner');
    await expect.poll(() => called.length).toBe(2);
    const state = await store.read();
    state.connectors[2]!.trustApproval = null;
    await store.write(0, state);
    pending.splice(0).forEach((resolve) => resolve());
    await expect.poll(() => hub.checks.discovering()).toBe(false);
    expect(called).toEqual(['connector-0', 'connector-1']);
  } finally {
    pending.splice(0).forEach((resolve) => resolve());
    await hub.close();
  }
});

it('retries admission when a Docker job finishes before its safety conflict is handled', async () => {
  const safety = createMemorySafetyLedger();
  const assertWritable = safety.assertWritable.bind(safety);
  let admissions = 0;
  let release!: () => void;
  const calls: string[] = [];
  const hub = createLifecycle(
    memoryStore(profileState(['docker', 'native'])),
    Date.now,
    safety,
    {
      runtime: {
        async discover(connector) {
          calls.push(connector.id);
          if (connector.executionMode === 'docker')
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return result;
        },
      },
    },
  );
  safety.assertWritable = async () => {
    admissions++;
    try {
      await assertWritable();
    } catch (error) {
      if (admissions === 3) {
        release();
        await expect
          .poll(async () => (await hub.checks.observations())[0]!.state)
          .toBe('connected');
      }
      throw error;
    }
  };
  try {
    await hub.checks.discoverApproved('owner');
    await expect.poll(() => hub.checks.discovering()).toBe(false);
    expect(calls).toEqual(['connector-0', 'connector-1']);
  } finally {
    release?.();
    await hub.close();
  }
});
