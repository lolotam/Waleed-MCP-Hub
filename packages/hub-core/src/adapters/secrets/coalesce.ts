// Protected reads that arrive while one protected-store process runs are
// answered together by the next one. Parallel peer startups used to launch
// one PowerShell per credential, one after another; a startup burst now
// costs one or two launches. Exactly one batch runs at a time, so the
// bounded credential runner is never asked for more than it allows.
//
// `runBatch` must read every item before its first await: a caller that
// gives up during the run is rejected at once and wipes its own buffers.
// It answers one value per item, undefined for an item that failed.
export function coalesceReads<T>(
  runBatch: (items: T[]) => Promise<Array<Buffer | undefined>>,
  fits: (items: T[]) => boolean,
) {
  interface Waiter {
    item: T;
    signal: AbortSignal;
    settled: boolean;
    resolve(value: Buffer): void;
    reject(reason: unknown): void;
    onAbort(): void;
  }
  const queue: Waiter[] = [];
  let running = false;

  // The longest prefix of the queue that fits one process; never empty.
  const takeBatch = () => {
    const batch = [queue.shift()!];
    while (queue.length && fits([...batch, queue[0]!].map((w) => w.item)))
      batch.push(queue.shift()!);
    return batch;
  };
  const answer = (waiter: Waiter, value: Buffer | undefined) => {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiter.settled) value?.fill(0);
    else if (value) waiter.resolve(value);
    else waiter.reject(new Error('Protected read failed.'));
    waiter.settled = true;
  };
  const pump = () => {
    if (running || !queue.length) return;
    running = true;
    const batch = takeBatch();
    void runBatch(batch.map((waiter) => waiter.item))
      .then(
        (values) => batch.forEach((waiter, i) => answer(waiter, values[i])),
        () => batch.forEach((waiter) => answer(waiter, undefined)),
      )
      .finally(() => {
        running = false;
        pump();
      });
  };

  return (item: T, signal: AbortSignal) =>
    new Promise<Buffer>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const waiter: Waiter = {
        item,
        signal,
        settled: false,
        resolve,
        reject,
        onAbort() {
          const queued = queue.indexOf(waiter);
          if (queued >= 0) queue.splice(queued, 1);
          waiter.settled = true;
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      queue.push(waiter);
      pump();
    });
}
