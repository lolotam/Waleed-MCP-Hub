import { describe, expect, it, vi } from 'vitest';
import {
  createSessionPool,
  type EntryInfo,
  type PoolLimits,
  type SessionPool,
} from '../packages/hub-core/src/integrations/session-pool.js';
import { RuntimeFault } from '../packages/hub-core/src/runtime/capabilities.js';

// The pool never reads a real clock: every timer is listed and fired by hand.
class FakeClock {
  private current = 1_700_000_000_000;
  private next = 1;
  readonly timers = new Map<
    number,
    { at: number; delay: number; callback: () => void }
  >();
  // Kept after `clearTimer` so a stale generation callback can be replayed.
  readonly history: { id: number; delay: number; callback: () => void }[] = [];

  readonly now = () => this.current;
  readonly setTimer = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.current + ms, delay: ms, callback });
    this.history.push({ id, delay: ms, callback });
    return id;
  };
  readonly clearTimer = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  advance(ms: number, skip?: (delay: number) => boolean) {
    const target = this.current + ms;
    for (;;) {
      let due: { at: number; delay: number; callback: () => void } | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at > target) continue;
        if (skip?.(timer.delay)) continue;
        if (!due || timer.at < due.at) due = timer;
      }
      if (!due) break;
      for (const [id, timer] of this.timers)
        if (timer === due) this.timers.delete(id);
      this.current = due.at;
      due.callback();
    }
    this.current = target;
  }
}

interface FakePeer {
  id: number;
  key: string;
  disposed: number;
  died: () => void;
  lifetime: AbortSignal;
}

interface Harness {
  clock: FakeClock;
  peers: FakePeer[];
  pool: SessionPool<FakePeer>;
}

interface HarnessConfig {
  limits?: Partial<PoolLimits>;
  // Awaited inside `start`, after the peer is registered.
  beforeStart?: (peer: FakePeer) => Promise<void>;
  fail?: boolean;
  notAfter?: (peer: FakePeer) => number | undefined;
  dispose?: (peer: FakePeer) => Promise<void>;
}

function createHarness(config: HarnessConfig = {}): Harness {
  const clock = new FakeClock();
  const peers: FakePeer[] = [];
  const pool = createSessionPool<FakePeer>({
    async start(key, lifetime, died) {
      const peer: FakePeer = {
        id: peers.length + 1,
        key,
        disposed: 0,
        died,
        lifetime,
      };
      peers.push(peer);
      // A real start stops when its lifetime aborts; so does the fake.
      if (config.beforeStart)
        await Promise.race([
          config.beforeStart(peer),
          new Promise<never>((_, reject) => {
            if (lifetime.aborted) reject(new Error('start cancelled'));
            lifetime.addEventListener(
              'abort',
              () => reject(new Error('start cancelled')),
              { once: true },
            );
          }),
        ]);
      if (config.fail) throw new Error('start failed');
      const notAfter = config.notAfter?.(peer);
      return notAfter === undefined ? { peer } : { peer, notAfter };
    },
    async dispose(peer) {
      peer.disposed += 1;
      if (config.dispose) await config.dispose(peer);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(config.limits ? { limits: config.limits } : {}),
  });
  return { clock, peers, pool };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const signal = () => new AbortController().signal;

describe('session pool', () => {
  it('row 1: two concurrent requests share one startup and are served in order', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      beforeStart: async () => gate,
    });
    const order: string[] = [];
    const first = harness.pool.use('c1', signal(), 60_000, async () => {
      order.push('first');
      await flush();
      return 'first';
    });
    const second = harness.pool.use('c1', signal(), 60_000, async () => {
      order.push('second');
      return 'second';
    });
    await flush();
    expect(harness.peers).toHaveLength(1);
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first', 'second']);
    expect(harness.pool.size).toBe(1);
  });

  it('row 2: a failed startup fails every waiter and leaves no entry', async () => {
    const harness = createHarness({ fail: true });
    const first = harness.pool.use('c1', signal(), 60_000, async () => 'first');
    const second = harness.pool.use(
      'c1',
      signal(),
      60_000,
      async () => 'second',
    );
    await expect(first).rejects.toMatchObject({
      reason: 'dependency_unavailable',
    });
    await expect(second).rejects.toBeInstanceOf(RuntimeFault);
    expect(harness.pool.size).toBe(0);
  });

  it('row 3: one waiter cancelling during a shared startup leaves the others served', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      beforeStart: async () => gate,
    });
    const controller = new AbortController();
    const first = harness.pool.use(
      'c1',
      controller.signal,
      60_000,
      async () => 'first',
    );
    const second = harness.pool.use(
      'c1',
      signal(),
      60_000,
      async () => 'second',
    );
    await flush();
    controller.abort();
    await expect(first).rejects.toMatchObject({ reason: 'cancelled' });
    release();
    await expect(second).resolves.toBe('second');
    expect(harness.pool.size).toBe(1);
    expect(harness.peers[0]?.lifetime.aborted).toBe(false);
  });

  it('row 4: the last waiter cancelling during startup cancels the startup and disposes the entry', async () => {
    const harness = createHarness({
      beforeStart: async () => new Promise<void>(() => undefined),
    });
    const controller = new AbortController();
    const pending = harness.pool.use(
      'c1',
      controller.signal,
      60_000,
      async () => 'first',
    );
    await flush();
    expect(harness.pool.size).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    await flush();
    expect(harness.pool.size).toBe(0);
    expect(harness.peers[0]?.lifetime.aborted).toBe(true);
  });

  it('row 5: a peer dying during startup fails the waiters and leaves no entry', async () => {
    const harness = createHarness({
      beforeStart: async (peer) => {
        peer.died();
        return new Promise<void>(() => undefined);
      },
    });
    const pending = harness.pool.use(
      'c1',
      signal(),
      60_000,
      async () => 'first',
    );
    await expect(pending).rejects.toMatchObject({
      reason: 'dependency_unavailable',
    });
    expect(harness.pool.size).toBe(0);
  });

  it('row 6: a deadline passing after the request succeeded keeps the peer alive and reusable', async () => {
    const harness = createHarness();
    await harness.pool.use('c1', signal(), 1000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    harness.clock.advance(5000);
    expect(harness.peers[0]?.disposed).toBe(0);
    const again = await harness.pool.use('c1', signal(), 1000, async (lease) =>
      lease.request(2, true, async () => 'ok'),
    );
    expect(again).toBe('ok');
    expect(harness.peers).toHaveLength(1);
  });

  it('row 7: a call that times out after dispatch invalidates the entry without a replay', async () => {
    const harness = createHarness();
    const send = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
      });
      return 'never';
    });
    const pending = harness.pool.use('c1', signal(), 1000, async (lease) =>
      lease.request(1, true, send),
    );
    await flush();
    harness.clock.advance(1000);
    await expect(pending).rejects.toMatchObject({ reason: 'timed_out' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.peers[0]?.disposed).toBe(1);
    await harness.pool.use('c1', signal(), 1000, async (lease) =>
      lease.request(2, true, async () => 'fresh'),
    );
    expect(harness.peers).toHaveLength(2);
  });

  it('row 17: max life reached while busy lets the call finish and retires the entry', async () => {
    const harness = createHarness({ limits: { maxLifeMs: 1000 } });
    const pending = harness.pool.use('c1', signal(), 60_000, async (lease) => {
      const first = await lease.request(1, true, async () => 'first');
      harness.clock.advance(1000);
      const second = await lease.request(2, false, async () => 'second');
      return `${first}:${second}`;
    });
    await expect(pending).resolves.toBe('first:second');
    await flush();
    expect(harness.peers[0]?.disposed).toBe(1);
    const fresh = await harness.pool.use('c1', signal(), 1000, async (lease) =>
      lease.request(3, true, async () => 'fresh'),
    );
    expect(fresh).toBe('fresh');
    expect(harness.peers).toHaveLength(2);
  });

  it('row 18: a replacement that needs the last slot fails without a seventeenth entry', async () => {
    const harness = createHarness({
      limits: { capacity: 1, maxLifeMs: 1000 },
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = harness.pool.use('c1', signal(), 60_000, async (lease) => {
      await lease.request(1, true, async () => 'ok');
      harness.clock.advance(1000);
      await gate;
      return 'done';
    });
    await flush();
    expect(harness.pool.size).toBe(1);
    await expect(
      harness.pool.use('c2', signal(), 1000, async () => 'nope'),
    ).rejects.toMatchObject({ reason: 'dependency_unavailable' });
    expect(harness.pool.size).toBe(1);
    release();
    await expect(busy).resolves.toBe('done');
  });

  it('row 19: an old generation death or timer callback has no effect on the replacement', async () => {
    const harness = createHarness();
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    const old = harness.peers[0];
    harness.pool.retire('c1');
    await flush();
    const fresh = await harness.pool.use(
      'c1',
      signal(),
      60_000,
      async (lease) => lease.request(2, true, async () => 'fresh'),
    );
    expect(fresh).toBe('fresh');
    expect(harness.peers).toHaveLength(2);
    old?.died();
    await flush();
    expect(harness.peers[1]?.disposed).toBe(0);
    const stale = harness.clock.history.find(
      (timer) => timer.delay === 300_000,
    );
    stale?.callback();
    await flush();
    expect(harness.peers[1]?.disposed).toBe(0);
    const again = await harness.pool.use(
      'c1',
      signal(),
      60_000,
      async (lease) => lease.request(3, true, async () => 'again'),
    );
    expect(again).toBe('again');
    expect(harness.peers).toHaveLength(2);
  });

  it('row 20: a seventeenth connector with all sixteen entries busy fails as unavailable', async () => {
    const harness = createHarness();
    for (let index = 0; index < 16; index += 1) {
      void harness.pool.use(`c${index}`, signal(), 60_000, async (lease) => {
        await lease.request(1, true, async () => 'ok');
        await new Promise<void>(() => undefined);
      });
    }
    await flush();
    expect(harness.pool.size).toBe(16);
    await expect(
      harness.pool.use('c16', signal(), 1000, async () => 'nope'),
    ).rejects.toMatchObject({ reason: 'dependency_unavailable' });
    expect(harness.pool.size).toBe(16);
  });

  it('row 25: a cancellation after a finished request does not abort the request signal', async () => {
    const controller = new AbortController();
    const harness = createHarness();
    let requestSignal: AbortSignal | undefined;
    const result = await harness.pool.use(
      'c1',
      controller.signal,
      60_000,
      async (lease) => {
        const value = await lease.request(1, true, async (signal) => {
          requestSignal = signal;
          return 'ok';
        });
        controller.abort();
        await flush();
        expect(requestSignal?.aborted).toBe(false);
        return value;
      },
    );
    expect(result).toBe('ok');
    expect(requestSignal?.aborted).toBe(false);
  });

  it('row 26: a retiring entry frees its own slot and leaves the replacement untouched', async () => {
    const harness = createHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = harness.pool.use('c1', signal(), 60_000, async (lease) => {
      await lease.request(1, true, async () => 'ok');
      await gate;
      return 'done';
    });
    await flush();
    harness.pool.retire('c1');
    await flush();
    const replacement = await harness.pool.use(
      'c1',
      signal(),
      60_000,
      async (lease) => lease.request(2, true, async () => 'fresh'),
    );
    expect(replacement).toBe('fresh');
    release();
    await expect(busy).resolves.toBe('done');
    await flush();
    expect(harness.peers[0]?.disposed).toBe(1);
    expect(harness.peers[1]?.disposed).toBe(0);
    expect(harness.pool.size).toBe(1);
  });

  it('row 27: a stale reconciliation result does not touch the replacement', async () => {
    const harness = createHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = harness.pool.use('c1', signal(), 60_000, async (lease) => {
      await lease.request(1, true, async () => 'ok');
      await gate;
      return 'done';
    });
    await flush();
    harness.pool.retire('c1');
    await flush();
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(6, true, async () => 'fresh'),
    );
    const seen: EntryInfo[] = [];
    harness.pool.reconcile(5, (info) => {
      seen.push(info);
      return 'invalidate';
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.generation).toBe(1);
    await flush();
    expect(harness.peers[1]?.disposed).toBe(0);
    const again = await harness.pool.use(
      'c1',
      signal(),
      60_000,
      async (lease) => lease.request(7, true, async () => 'again'),
    );
    expect(again).toBe('again');
    expect(harness.peers).toHaveLength(2);
    release();
    // Its own entry was invalidated during result handling: the result is gone.
    await expect(busy).rejects.toMatchObject({
      reason: 'dependency_unavailable',
    });
    await flush();
  });

  it('row 33: the final gate refuses by clock when the max age is crossed', async () => {
    const harness = createHarness();
    const send = vi.fn(async () => 'ok');
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, send),
    );
    // The retirement timer is withheld; only the clock moves.
    harness.clock.advance(
      3_600_001,
      (delay) => delay === 300_000 || delay === 3_600_000,
    );
    await expect(
      harness.pool.use('c1', signal(), 60_000, async (lease) =>
        lease.request(2, true, send),
      ),
    ).rejects.toMatchObject({ reason: 'dependency_unavailable' });
    expect(send).toHaveBeenCalledTimes(1);
    const fresh = await harness.pool.use(
      'c1',
      signal(),
      60_000,
      async (lease) => lease.request(3, true, send),
    );
    expect(fresh).toBe('ok');
  });

  it('row 37: the max age timer between pages keeps the remaining pages served', async () => {
    const harness = createHarness({ limits: { maxLifeMs: 1000 } });
    const send = vi.fn(async () => 'page');
    const result = await harness.pool.use(
      'c1',
      signal(),
      60_000,
      async (lease) => {
        const first = await lease.request(1, true, send);
        harness.clock.advance(1000);
        const second = await lease.request(2, false, send);
        return `${first}:${second}`;
      },
    );
    expect(result).toBe('page:page');
    expect(send).toHaveBeenCalledTimes(2);
    await flush();
    expect(harness.peers[0]?.disposed).toBe(1);
  });

  it('a cancelled waiter leaves the others served in FIFO order', async () => {
    const harness = createHarness();
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    const order: string[] = [];
    const runs = controllers.map((controller, index) =>
      harness.pool.use('c1', controller.signal, 60_000, async () => {
        order.push(`op${index}`);
        await flush();
        return `op${index}`;
      }),
    );
    await flush();
    controllers[1]?.abort();
    await expect(runs[1]).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(runs[0]).resolves.toBe('op0');
    await expect(runs[2]).resolves.toBe('op2');
    expect(order).toEqual(['op0', 'op2']);
  });

  it('dispose runs exactly once per entry when invalidate, retire, death and close all hit it', async () => {
    const harness = createHarness();
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    const peer = harness.peers[0];
    harness.pool.invalidate('c1');
    harness.pool.retire('c1');
    peer?.died();
    await harness.pool.close(1000);
    await flush();
    expect(peer?.disposed).toBe(1);
  });

  it('the lease timer invalidates thirty seconds before the lease ends', async () => {
    const harness = createHarness({
      notAfter: () => harness.clock.now() + 60_000,
    });
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    const peer = harness.peers[0];
    harness.clock.advance(29_999);
    await flush();
    expect(peer?.disposed).toBe(0);
    harness.clock.advance(1);
    await flush();
    expect(peer?.disposed).toBe(1);
    expect(harness.pool.size).toBe(0);
  });

  it('replace retires the old entry and admits on a fresh generation in one operation', async () => {
    const harness = createHarness();
    const generations: number[] = [];
    const result = await harness.pool.use(
      'c1',
      signal(),
      60_000,
      async (lease) => {
        generations.push(lease.generation);
        const first = await lease.request(1, true, async () => 'first');
        await lease.replace();
        generations.push(lease.generation);
        const second = await lease.request(2, true, async () => 'second');
        return `${first}:${second}`;
      },
    );
    expect(result).toBe('first:second');
    expect(generations[1]).not.toBe(generations[0]);
    expect(harness.peers).toHaveLength(2);
    expect(harness.peers[0]?.disposed).toBe(1);
    expect(harness.peers[1]?.disposed).toBe(0);
  });

  it('reconcile skips entries whose validated sequence is not older than the snapshot', async () => {
    const harness = createHarness();
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(5, true, async () => 'ok'),
    );
    const seen: EntryInfo[] = [];
    harness.pool.reconcile(5, (info) => {
      seen.push(info);
      return 'invalidate';
    });
    expect(seen).toHaveLength(0);
    harness.pool.reconcile(6, (info) => {
      seen.push(info);
      return 'invalidate';
    });
    expect(seen).toHaveLength(1);
    await flush();
    expect(harness.peers[0]?.disposed).toBe(1);
  });

  it('close resolves by its deadline when a disposal never settles', async () => {
    const harness = createHarness({
      dispose: () => new Promise<void>(() => undefined),
    });
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    await harness.pool.use('c2', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    const closing = harness.pool.close(1000);
    harness.clock.advance(1000);
    await expect(closing).resolves.toBeUndefined();
    await expect(
      harness.pool.use('c3', signal(), 1000, async () => 'nope'),
    ).rejects.toMatchObject({ reason: 'dependency_unavailable' });
  });

  it('the least recently used idle entry is retired to free a slot', async () => {
    const harness = createHarness({ limits: { capacity: 1 } });
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    const first = harness.peers[0];
    const second = await harness.pool.use(
      'c2',
      signal(),
      60_000,
      async (lease) => lease.request(1, true, async () => 'ok'),
    );
    expect(second).toBe('ok');
    expect(first?.disposed).toBe(1);
    expect(harness.peers).toHaveLength(2);
    expect(harness.pool.size).toBe(1);
  });

  it('concurrent starts for different keys never exceed the capacity', async () => {
    const harness = createHarness({ limits: { capacity: 2 } });
    const settled = await Promise.allSettled(
      ['c1', 'c2', 'c3'].map((key) =>
        harness.pool.use(key, signal(), 60_000, async (lease) =>
          lease.request(1, true, async () => 'ok'),
        ),
      ),
    );
    expect(harness.pool.size).toBeLessThanOrEqual(2);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      2,
    );
  });

  it('a launching peer keeps its slot until its start settles', async () => {
    let finish: () => void = () => undefined;
    const pool = createSessionPool<string>({
      // This start ignores its lifetime: the slot must stay counted.
      start: () =>
        new Promise((resolve) => {
          finish = () => resolve({ peer: 'late' });
        }),
      dispose: async () => undefined,
      now: () => 0,
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    const controller = new AbortController();
    const pending = pool.use('c1', controller.signal, 60_000, async () => 'x');
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    await flush();
    expect(pool.size).toBe(1);
    finish();
    await flush();
    expect(pool.size).toBe(0);
  });

  it('graceful retirement sends queued requests to a fresh entry', async () => {
    const harness = createHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => {
        await gate;
        return 'first';
      }),
    );
    await flush();
    const second = harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(2, true, async () => `second-${lease.generation}`),
    );
    await flush();
    harness.pool.retire('c1');
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toMatch(/^second-/);
    expect(harness.peers).toHaveLength(2);
    expect(harness.peers[0]?.disposed).toBe(1);
  });

  it('replace() never shares the fresh entry with a queued request', async () => {
    const harness = createHarness();
    const holders = new Set<number>();
    let active = 0;
    let overlap = false;
    const run = (seq: number) =>
      harness.pool.use('c1', signal(), 60_000, async (lease) => {
        if (seq === 1) await lease.replace();
        return lease.request(seq, true, async () => {
          active += 1;
          if (active > 1) overlap = true;
          holders.add(lease.generation);
          await flush();
          active -= 1;
          return seq;
        });
      });
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(0, true, async () => 0),
    );
    const results = await Promise.all([run(1), run(2), run(3)]);
    expect(results).toEqual([1, 2, 3]);
    expect(overlap).toBe(false);
  });

  it('a slow disposal keeps the slot even when a late start and a cancel both close the peer', async () => {
    let finishStart: () => void = () => undefined;
    let finishDispose: () => void = () => undefined;
    let disposals = 0;
    const pool = createSessionPool<string>({
      start: () =>
        new Promise((resolve) => {
          finishStart = () => resolve({ peer: 'late' });
        }),
      dispose: () => {
        disposals += 1;
        return new Promise<void>((resolve) => {
          finishDispose = resolve;
        });
      },
      now: () => 0,
      setTimer: () => undefined,
      clearTimer: () => undefined,
      limits: { capacity: 1 },
    });
    const controller = new AbortController();
    const pending = pool.use('c1', controller.signal, 60_000, async () => 'x');
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    finishStart();
    await flush();
    expect(disposals).toBe(1);
    expect(pool.size).toBe(1);
    finishDispose();
    await flush();
    expect(pool.size).toBe(0);
  });

  it('a disposer that throws synchronously runs once and frees the slot', async () => {
    let finishStart: () => void = () => undefined;
    let disposals = 0;
    const pool = createSessionPool<string>({
      start: () =>
        new Promise((resolve) => {
          finishStart = () => resolve({ peer: 'late' });
        }),
      dispose: () => {
        disposals += 1;
        throw new Error('synchronous disposal failure');
      },
      now: () => 0,
      setTimer: () => undefined,
      clearTimer: () => undefined,
      limits: { capacity: 1 },
    });
    const controller = new AbortController();
    const pending = pool.use('c1', controller.signal, 60_000, async () => 'x');
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    finishStart();
    await flush();
    expect(disposals).toBe(1);
    expect(pool.size).toBe(0);
  });

  it('cancellation after dispatch invalidates even when the send later succeeds', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    let finish: () => void = () => undefined;
    const pending = harness.pool.use(
      'c1',
      controller.signal,
      60_000,
      async (lease) =>
        lease.request(
          1,
          true,
          () =>
            new Promise<string>((resolve) => {
              finish = () => resolve('late');
            }),
        ),
    );
    await flush();
    controller.abort();
    await flush();
    expect(harness.peers[0]?.disposed).toBe(1);
    finish();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(2, true, async () => 'fresh'),
    );
    expect(harness.peers).toHaveLength(2);
  });

  it('a timeout raised by the request itself invalidates the peer', async () => {
    const harness = createHarness();
    await expect(
      harness.pool.use('c1', signal(), 60_000, async (lease) =>
        lease.request(1, true, async () => {
          throw new RuntimeFault('timed_out');
        }),
      ),
    ).rejects.toMatchObject({ reason: 'timed_out' });
    await flush();
    expect(harness.peers[0]?.disposed).toBe(1);
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(2, true, async () => 'fresh'),
    );
    expect(harness.peers).toHaveLength(2);
  });

  it('an acquisition paused for capacity does not start a peer after close', async () => {
    const harness = createHarness({
      limits: { capacity: 1 },
      dispose: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    });
    await harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    const pending = harness.pool.use('c2', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => 'ok'),
    );
    const closing = harness.pool.close(1000);
    await expect(pending).rejects.toMatchObject({
      reason: 'dependency_unavailable',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await closing;
    expect(harness.pool.size).toBe(0);
    expect(harness.peers).toHaveLength(1);
  });

  it('a startup that never settles fails on the startup deadline', async () => {
    const harness = createHarness({
      beforeStart: async () => new Promise<void>(() => undefined),
    });
    const pending = harness.pool.use(
      'c1',
      signal(),
      60_000,
      async () => 'first',
    );
    await flush();
    harness.clock.advance(20_000);
    await expect(pending).rejects.toMatchObject({
      reason: 'dependency_unavailable',
    });
    expect(harness.pool.size).toBe(0);
  });

  it('a result produced after an invalidation is discarded', async () => {
    const harness = createHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = harness.pool.use('c1', signal(), 60_000, async (lease) =>
      lease.request(1, true, async () => {
        await gate;
        return 'late';
      }),
    );
    await flush();
    harness.pool.invalidate('c1');
    release();
    await expect(pending).rejects.toMatchObject({
      reason: 'dependency_unavailable',
    });
  });
});
