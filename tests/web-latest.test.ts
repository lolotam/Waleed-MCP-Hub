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
    await expect(run(recorder('a', log, Promise.resolve()))).resolves.toBe(
      true,
    );
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
    await expect(b).resolves.toBe(true);
    // The superseded call reports the outcome of the newest call.
    await expect(a).resolves.toBe(true);
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
    await expect(a).resolves.toBe(false);
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

describe('latestRunner outcome', () => {
  it('resolves to false for a call whose work fails', async () => {
    const log: string[] = [];
    const run = latestRunner(1000);
    const failed = Promise.reject(new DOMException('down', 'NetworkError'));
    await expect(run(recorder('a', log, failed))).resolves.toBe(false);
    expect(log).toEqual(['a:begin', 'a:fail:NetworkError', 'a:end']);
  });

  it('gives a superseded call the failure of the newest call', async () => {
    const log: string[] = [];
    const run = latestRunner(1000);
    const first = gate();
    const a = run(recorder('a', log, first.opened));
    const b = run(
      recorder(
        'b',
        log,
        Promise.reject(new DOMException('down', 'NetworkError')),
      ),
    );
    await expect(b).resolves.toBe(false);
    await expect(a).resolves.toBe(false);
  });
});

describe('latestRunner chains', () => {
  it('gives every call of a chain of three the outcome of the third', async () => {
    const log: string[] = [];
    const run = latestRunner(1000);
    const first = gate();
    const slow = gate();
    const third = gate();
    const a = run(recorder('a', log, first.opened));
    // The middle call ignores its abort and settles only after the newest
    // call has finished and nothing is running any more.
    const b = run({
      ...recorder('b', log, slow.opened),
      work: () => slow.opened,
    });
    const c = run(recorder('c', log, third.opened));
    third.open();
    await expect(c).resolves.toBe(true);
    slow.open();
    await expect(b).resolves.toBe(true);
    await expect(a).resolves.toBe(true);
    expect(log).toEqual(['a:begin', 'b:begin', 'c:begin', 'c:commit', 'c:end']);
  });

  it('gives every call of a chain of three the failure of the third', async () => {
    const log: string[] = [];
    const run = latestRunner(1000);
    const slow = gate();
    const a = run(recorder('a', log, gate().opened));
    const b = run({
      ...recorder('b', log, slow.opened),
      work: () => slow.opened,
    });
    const c = run(
      recorder(
        'c',
        log,
        Promise.reject(new DOMException('down', 'NetworkError')),
      ),
    );
    await expect(c).resolves.toBe(false);
    slow.open();
    await expect(b).resolves.toBe(false);
    await expect(a).resolves.toBe(false);
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
