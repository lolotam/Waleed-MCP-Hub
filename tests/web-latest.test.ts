import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestRunner, untilAborted } from '../apps/web/src/latest.js';

// A task that settles only when the test says so, or rejects on abort.
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function recorder(name: string, log: string[], wait: Promise<void>) {
  return {
    begin: () => log.push(`${name}:begin`),
    work: async (signal: AbortSignal, current: () => boolean) => {
      await untilAborted(wait, signal);
      if (current()) log.push(`${name}:commit`);
    },
    fail: (error: unknown) =>
      log.push(`${name}:fail:${(error as DOMException).name}`),
    end: () => log.push(`${name}:end`),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('latestRunner', () => {
  it('commits and ends a call that stays the newest', async () => {
    const log: string[] = [];
    const run = latestRunner(1000);
    await run(recorder('a', log, Promise.resolve()));
    expect(log).toEqual(['a:begin', 'a:commit', 'a:end']);
  });

  it('aborts an older call, which commits, fails and ends nothing', async () => {
    const log: string[] = [];
    const run = latestRunner(1000);
    const first = gate();
    const second = gate();
    const a = run(recorder('a', log, first.opened));
    const b = run(recorder('b', log, second.opened));
    second.open();
    await b;
    await a;
    expect(log).toEqual(['a:begin', 'b:begin', 'b:commit', 'b:end']);
  });

  it('settles a superseded call only after the newest call settles', async () => {
    const log: string[] = [];
    const run = latestRunner(1000);
    const first = gate();
    const second = gate();
    let aSettled = false;
    const a = run(recorder('a', log, first.opened)).then(() => {
      aSettled = true;
    });
    const b = run(recorder('b', log, second.opened));
    // The older call was aborted at once, but it still waits for the newest.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aSettled).toBe(false);
    second.open();
    await b;
    await a;
    expect(aSettled).toBe(true);
    expect(log.at(-1)).toBe('b:end');
  });

  it('ends a stalled call with a TimeoutError after the limit', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const run = latestRunner(20_000);
    const never = gate();
    const a = run(recorder('a', log, never.opened));
    await vi.advanceTimersByTimeAsync(20_000);
    await a;
    expect(log).toEqual(['a:begin', 'a:fail:TimeoutError', 'a:end']);
  });

  it('never lets the timeout of an older call fail the newest call', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const run = latestRunner(20_000);
    const never = gate();
    const a = run(recorder('a', log, never.opened));
    await vi.advanceTimersByTimeAsync(10_000);
    const b = run(recorder('b', log, Promise.resolve()));
    await b;
    await vi.advanceTimersByTimeAsync(30_000);
    await a;
    expect(log).toEqual(['a:begin', 'b:begin', 'b:commit', 'b:end']);
  });
});

describe('untilAborted', () => {
  it('rejects with the abort reason while the promise keeps running', async () => {
    const controller = new AbortController();
    const task = gate();
    let finished = false;
    const shared = task.opened.then(() => {
      finished = true;
      return 'session';
    });
    const waiting = untilAborted(shared, controller.signal);
    controller.abort(new DOMException('late', 'TimeoutError'));
    await expect(waiting).rejects.toMatchObject({ name: 'TimeoutError' });
    task.open();
    await expect(shared).resolves.toBe('session');
    expect(finished).toBe(true);
  });

  it('rejects at once for a signal that already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(
      untilAborted(Promise.resolve(1), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
