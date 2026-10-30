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
// Every call resolves to whether the newest call's work succeeded: each call
// is linked to the call that replaced it, and takes that call's outcome.
export function latestRunner(limitMs: number) {
  interface Run {
    controller: AbortController;
    // Settles with the final outcome, after the replacing call settled.
    done: Promise<boolean>;
    // The call that replaced this one, if any.
    next: Run | null;
  }
  let latest: Run | null = null;
  return async function run(steps: LatestSteps): Promise<boolean> {
    let finish: (ok: boolean) => void = () => {};
    const own: Run = {
      controller: new AbortController(),
      done: new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
      next: null,
    };
    if (latest) {
      latest.next = own;
      latest.controller.abort();
    }
    let ok = false;
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
      ok = current();
    } catch (error) {
      if (current()) steps.fail(error);
    } finally {
      clearTimeout(timer);
      if (current()) {
        latest = null;
        steps.end();
      }
    }
    // A superseded call takes the final outcome of the call that replaced
    // it, which in turn waits for its own replacement, so a chain of calls
    // always carries the outcome of the newest one.
    if (own.next) ok = await own.next.done;
    finish(ok);
    return ok;
  };
}
