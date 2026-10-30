// Waits for a promise until the signal aborts, then rejects with its reason.
// The promise itself keeps running.
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (failure: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(failure);
      },
    );
  });
}

export interface LatestSteps {
  // Runs first, for the call that now owns the view.
  begin(): void;
  // The work. It commits only while `current()` is true.
  work(signal: AbortSignal, current: () => boolean): Promise<void>;
  // Runs on a failure, only when the call is still the newest.
  fail(error: unknown): void;
  // Runs last, only when the call is still the newest.
  end(): void;
}

// Runs calls where the newest one wins. A new call aborts the one before it,
// and every call is aborted with a TimeoutError after `limitMs`. A call that
// was superseded commits nothing (no failure and no end) and resolves only
// after the newest call settles, so its caller never sees stale data as fresh.
export function latestRunner(limitMs: number) {
  interface Run {
    controller: AbortController;
    done: Promise<void>;
  }
  let latest: Run | null = null;
  return async function run(steps: LatestSteps): Promise<void> {
    latest?.controller.abort();
    let finish = () => {};
    const own: Run = {
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    latest = own;
    const current = () => latest === own;
    const timer = setTimeout(
      () =>
        own.controller.abort(
          new DOMException('The call timed out.', 'TimeoutError'),
        ),
      limitMs,
    );
    steps.begin();
    try {
      await steps.work(own.controller.signal, current);
    } catch (error) {
      if (current()) steps.fail(error);
    } finally {
      clearTimeout(timer);
      if (current()) {
        latest = null;
        steps.end();
      }
      finish();
    }
    for (let newest = latest; newest && newest !== own; newest = latest)
      await newest.done;
  };
}
