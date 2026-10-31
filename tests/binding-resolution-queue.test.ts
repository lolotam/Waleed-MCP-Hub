import { expect, it } from 'vitest';
import { serializeBindingResolver } from '../packages/hub-core/src/auth/bindings.js';
import { connector } from './helpers/runtime.js';

it('queues parallel credential resolutions without exceeding backend capacity', async () => {
  let active = 0,
    peak = 0;
  const releases: Array<() => void> = [];
  const seen: string[] = [];
  const resolve = serializeBindingResolver(async (item) => {
    seen.push(item.id);
    peak = Math.max(peak, ++active);
    await new Promise<void>((release) => releases.push(release));
    active--;
    return { environment: {}, headers: {}, dispose() {} };
  });
  const signal = new AbortController().signal;
  const pending = Array.from({ length: 4 }, (_, index) =>
    resolve(connector(`queued-${index}`), signal),
  );
  try {
    for (let count = 1; count <= 4; count++) {
      await expect.poll(() => seen.length).toBe(count);
      releases.shift()!();
    }
    await Promise.all(pending);
    expect(peak).toBe(1);
  } finally {
    releases.splice(0).forEach((release) => release());
  }
});

it('releases a failed resolution and never reads a queued cancelled credential', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const resolve = serializeBindingResolver(async (item) => {
    seen.push(item.id);
    if (item.id === 'first') {
      await gate;
      throw new Error('synthetic failure');
    }
    return { environment: {}, headers: {}, dispose() {} };
  });
  const signal = new AbortController().signal;
  const cancelled = new AbortController();
  const first = resolve(connector('first'), signal).catch((error) => error);
  const skipped = resolve(connector('cancelled'), cancelled.signal).catch(
    (error) => error,
  );
  const last = resolve(connector('last'), signal);
  cancelled.abort();
  release();
  expect(await first).toBeInstanceOf(Error);
  expect((await skipped).name).toBe('AbortError');
  await last;
  expect(seen).toEqual(['first', 'last']);
});
