import { RuntimeFault } from '../runtime/capabilities.js';

export interface PoolLimits {
  capacity: number;
  idleMs: number;
  maxLifeMs: number;
  startupMs: number;
  leaseMarginMs: number;
}

export interface StartedPeer<P> {
  peer: P;
  notAfter?: number;
  // Sequence of the snapshot that authorised this startup.
  seq?: number;
}

export interface SessionPoolOptions<P> {
  // Starts one peer. `lifetime` aborts when the entry is cancelled or disposed;
  // `died` must be wired to transport close/error before any protocol traffic.
  start(
    key: string,
    lifetime: AbortSignal,
    died: () => void,
  ): Promise<StartedPeer<P>>;
  // Closes one peer; the pool calls it at most once per entry.
  dispose(peer: P): Promise<void>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  limits?: Partial<PoolLimits>;
}

export interface EntryInfo {
  key: string;
  generation: number;
  validatedSeq: number;
  busy: boolean;
  state: 'starting' | 'ready' | 'busy' | 'retiring' | 'disposing';
}

export interface OperationLease<P> {
  readonly peer: P;
  readonly generation: number;
  readonly fresh: boolean;
  // The operation's own signal (caller cancellation or deadline).
  readonly signal: AbortSignal;
  // One SDK request. Runs the synchronous final gate, then calls `send` with no
  // await in between, passing an operation-owned AbortSignal. `admission` is
  // true for the operation's first request, false for a later page.
  request<T>(
    seq: number,
    admission: boolean,
    send: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  // Boot mismatch path: gracefully retire this entry and start a fresh one for
  // the same key within the operation's deadline; afterwards `peer`,
  // `generation` and `fresh` describe the new entry and the next request is an
  // admission again.
  replace(): Promise<void>;
  // Security invalidation of the entry this lease holds.
  invalidate(): void;
}

export interface SessionPool<P> {
  use<T>(
    key: string,
    signal: AbortSignal,
    deadlineMs: number,
    operation: (lease: OperationLease<P>) => Promise<T>,
  ): Promise<T>;
  invalidate(key: string | 'all'): void;
  retire(key: string | 'all'): void;
  // Synchronous reconciliation: `decide` is called for every live entry whose
  // validatedSeq < seq, with a snapshot of its info, and its answer applied at
  // once (marking only; disposal runs afterwards).
  reconcile(
    seq: number,
    decide: (entry: EntryInfo) => 'keep' | 'retire' | 'invalidate',
  ): void;
  close(deadlineMs: number): Promise<void>;
  readonly size: number;
}

const DEFAULT_LIMITS: PoolLimits = {
  capacity: 16,
  idleMs: 300_000,
  maxLifeMs: 3_600_000,
  startupMs: 20_000,
  leaseMarginMs: 30_000,
};

type EntryState = EntryInfo['state'];
type AbortReason = 'cancelled' | 'timed_out' | 'invalidated';

interface Entry<P> {
  key: string;
  generation: number;
  state: EntryState;
  invalidated: boolean;
  cancelled: boolean;
  failed: boolean;
  attempt: Promise<StartedPeer<P>> | undefined;
  lifetime: AbortController;
  peer: P | undefined;
  peerDisposal: Promise<void> | undefined;
  notAfter: number | undefined;
  startedAt: number;
  lastUsedAt: number;
  validatedSeq: number;
  busy: boolean;
  holder: Operation<P> | undefined;
  waiters: Waiter<P>[];
  timers: { startup: unknown; idle: unknown; life: unknown; lease: unknown };
  startup: Promise<void> | undefined;
  resolveStartup: (() => void) | undefined;
  rejectStartup: ((error: unknown) => void) | undefined;
  disposal: Promise<void> | undefined;
}

interface Operation<P> {
  controller: AbortController;
  signal: AbortSignal;
  reason: AbortReason | undefined;
  // Set when an entry this operation held was security-invalidated.
  invalidated: boolean;
  deadlineTimer: unknown;
  detachCaller: () => void;
  entry: Entry<P> | undefined;
  fresh: boolean;
}

interface Waiter<P> {
  op: Operation<P>;
  resolve: (entry: Entry<P> | undefined) => void;
  reject: (error: unknown) => void;
  done: boolean;
  detach: () => void;
}

interface LeaseState<P> {
  entry: Entry<P>;
  generation: number;
  admitted: boolean;
  admittedEntry: Entry<P> | undefined;
}

export function createSessionPool<P>(
  options: SessionPoolOptions<P>,
): SessionPool<P> {
  const limits: PoolLimits = {
    capacity: options.limits?.capacity ?? DEFAULT_LIMITS.capacity,
    idleMs: options.limits?.idleMs ?? DEFAULT_LIMITS.idleMs,
    maxLifeMs: options.limits?.maxLifeMs ?? DEFAULT_LIMITS.maxLifeMs,
    startupMs: options.limits?.startupMs ?? DEFAULT_LIMITS.startupMs,
    leaseMarginMs:
      options.limits?.leaseMarginMs ?? DEFAULT_LIMITS.leaseMarginMs,
  };
  const serving = new Map<string, Entry<P>>();
  const live = new Set<Entry<P>>();
  let generation = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  const fault = (
    reason: 'cancelled' | 'timed_out' | 'dependency_unavailable',
  ) => new RuntimeFault(reason);

  function abortOperation(op: Operation<P>, reason: AbortReason) {
    if (op.controller.signal.aborted) return;
    op.reason = reason;
    op.controller.abort();
  }

  // The operation owns one controller. The caller's signal and the deadline
  // are forwarded into it, and the listener is removed when the operation ends.
  function createOperation(
    signal: AbortSignal,
    deadlineMs: number,
  ): Operation<P> {
    const controller = new AbortController();
    const op: Operation<P> = {
      controller,
      signal: controller.signal,
      reason: undefined,
      invalidated: false,
      deadlineTimer: undefined,
      detachCaller: () => undefined,
      entry: undefined,
      fresh: false,
    };
    const onCaller = () => abortOperation(op, 'cancelled');
    if (signal.aborted) abortOperation(op, 'cancelled');
    else signal.addEventListener('abort', onCaller, { once: true });
    op.detachCaller = () => signal.removeEventListener('abort', onCaller);
    op.deadlineTimer = options.setTimer(
      () => abortOperation(op, 'timed_out'),
      deadlineMs,
    );
    return op;
  }

  function cleanupOperation(op: Operation<P>) {
    if (op.deadlineTimer !== undefined) {
      options.clearTimer(op.deadlineTimer);
      op.deadlineTimer = undefined;
    }
    op.detachCaller();
  }

  function operationFault(op: Operation<P>) {
    return fault(
      op.reason === 'timed_out'
        ? 'timed_out'
        : op.reason === 'invalidated'
          ? 'dependency_unavailable'
          : 'cancelled',
    );
  }

  // A timeout or cancellation after dispatch leaves the server's state
  // unknown: the peer must not serve another operation.
  function terminal(error: unknown) {
    return (
      error instanceof RuntimeFault &&
      (error.reason === 'timed_out' || error.reason === 'cancelled')
    );
  }

  function clearTimers(entry: Entry<P>) {
    for (const name of ['startup', 'idle', 'life', 'lease'] as const) {
      const handle = entry.timers[name];
      if (handle === undefined) continue;
      entry.timers[name] = undefined;
      options.clearTimer(handle);
    }
  }

  function createEntry(key: string): Entry<P> {
    return {
      key,
      generation: ++generation,
      state: 'starting',
      invalidated: false,
      cancelled: false,
      failed: false,
      attempt: undefined,
      lifetime: new AbortController(),
      peer: undefined,
      peerDisposal: undefined,
      notAfter: undefined,
      startedAt: 0,
      lastUsedAt: 0,
      validatedSeq: 0,
      busy: false,
      holder: undefined,
      waiters: [],
      timers: {
        startup: undefined,
        idle: undefined,
        life: undefined,
        lease: undefined,
      },
      startup: undefined,
      resolveStartup: undefined,
      rejectStartup: undefined,
      disposal: undefined,
    };
  }

  function toInfo(entry: Entry<P>): EntryInfo {
    return {
      key: entry.key,
      generation: entry.generation,
      validatedSeq: entry.validatedSeq,
      busy: entry.busy,
      state: entry.state,
    };
  }

  // Disposal is idempotent: the peer is closed once and the entry leaves
  // `live` only when its disposal settles.
  // Every caller awaits the same closing, so no one frees the slot early.
  function disposePeer(entry: Entry<P>): Promise<void> {
    const peer = entry.peer;
    if (peer === undefined) return Promise.resolve();
    // A synchronous throw from `dispose` is caught by the same handler.
    entry.peerDisposal ??= Promise.resolve()
      .then(() => options.dispose(peer))
      .catch(() => {
        /* The peer is gone either way; diagnostics never leave the pool. */
      });
    return entry.peerDisposal;
  }

  function disposeEntry(entry: Entry<P>): Promise<void> {
    if (entry.disposal) return entry.disposal;
    entry.disposal = (async () => {
      entry.state = 'disposing';
      clearTimers(entry);
      entry.lifetime.abort();
      if (serving.get(entry.key) === entry) serving.delete(entry.key);
      // A start still in flight keeps its slot until it settles.
      if (entry.attempt)
        try {
          entry.peer ??= (await entry.attempt).peer;
        } catch {
          /* A failed start left nothing to close. */
        }
      await disposePeer(entry);
      live.delete(entry);
    })();
    return entry.disposal;
  }

  function rejectWaiters(entry: Entry<P>) {
    const error = fault('dependency_unavailable');
    for (const waiter of entry.waiters.splice(0)) {
      waiter.done = true;
      waiter.detach();
      waiter.reject(error);
    }
  }

  // Waiters of a gracefully retired entry look again: they join or start a
  // fresh entry instead of failing.
  function rerouteWaiters(entry: Entry<P>) {
    for (const waiter of entry.waiters.splice(0)) {
      waiter.done = true;
      waiter.detach();
      waiter.resolve(undefined);
    }
  }

  // Security invalidation: the entry is aborted at once.
  function invalidateEntry(entry: Entry<P>) {
    if (entry.invalidated || entry.disposal) return;
    entry.invalidated = true;
    entry.state = 'retiring';
    if (serving.get(entry.key) === entry) serving.delete(entry.key);
    rejectWaiters(entry);
    const holder = entry.holder;
    if (holder) {
      holder.invalidated = true;
      abortOperation(holder, 'invalidated');
    }
    void disposeEntry(entry);
  }

  // Graceful retirement: no new operation, an in-flight one finishes.
  function retireEntry(entry: Entry<P>) {
    if (entry.invalidated || entry.disposal || entry.state === 'retiring')
      return;
    entry.state = 'retiring';
    if (serving.get(entry.key) === entry) serving.delete(entry.key);
    rerouteWaiters(entry);
    if (!entry.busy) void disposeEntry(entry);
  }

  function onDied(entry: Entry<P>) {
    if (entry.disposal) return;
    if (entry.state === 'starting') {
      failStartup(entry);
      return;
    }
    invalidateEntry(entry);
  }

  function failStartup(entry: Entry<P>) {
    if (entry.failed) return;
    entry.failed = true;
    if (entry.timers.startup !== undefined) {
      options.clearTimer(entry.timers.startup);
      entry.timers.startup = undefined;
    }
    if (serving.get(entry.key) === entry) serving.delete(entry.key);
    rejectWaiters(entry);
    const error = fault('dependency_unavailable');
    entry.rejectStartup?.(error);
    entry.resolveStartup = undefined;
    entry.rejectStartup = undefined;
    void disposeEntry(entry);
  }

  // The last waiter leaving a shared startup cancels it.
  function cancelStartup(entry: Entry<P>) {
    if (entry.state !== 'starting' || entry.cancelled) return;
    entry.cancelled = true;
    entry.lifetime.abort();
    const error = fault('dependency_unavailable');
    entry.rejectStartup?.(error);
    entry.resolveStartup = undefined;
    entry.rejectStartup = undefined;
    void disposeEntry(entry);
  }

  function beginStartup(entry: Entry<P>) {
    entry.state = 'starting';
    entry.startup = new Promise<void>((resolve, reject) => {
      entry.resolveStartup = resolve;
      entry.rejectStartup = reject;
    });
    entry.startup.catch(() => undefined);
    entry.timers.startup = options.setTimer(
      () => failStartup(entry),
      limits.startupMs,
    );
    entry.attempt = Promise.resolve().then(() =>
      options.start(entry.key, entry.lifetime.signal, () => onDied(entry)),
    );
    void entry.attempt.then(
      (started) => completeStartup(entry, started),
      () => failStartup(entry),
    );
  }

  async function completeStartup(
    entry: Entry<P>,
    started: StartedPeer<P>,
  ): Promise<void> {
    entry.peer = started.peer;
    if (
      entry.failed ||
      entry.cancelled ||
      entry.invalidated ||
      entry.disposal
    ) {
      await disposePeer(entry);
      return;
    }
    if (started.notAfter !== undefined) {
      const leaseAt = started.notAfter - limits.leaseMarginMs;
      if (leaseAt <= options.now()) {
        failStartup(entry);
        return;
      }
      entry.notAfter = started.notAfter;
      entry.timers.lease = options.setTimer(
        () => invalidateEntry(entry),
        leaseAt - options.now(),
      );
    }
    if (entry.timers.startup !== undefined) {
      options.clearTimer(entry.timers.startup);
      entry.timers.startup = undefined;
    }
    entry.startedAt = options.now();
    entry.lastUsedAt = entry.startedAt;
    entry.validatedSeq = started.seq ?? 0;
    entry.state = 'ready';
    entry.timers.life = options.setTimer(
      () => retireEntry(entry),
      limits.maxLifeMs,
    );
    entry.resolveStartup?.();
    entry.resolveStartup = undefined;
    entry.rejectStartup = undefined;
    const waiter = entry.waiters.shift();
    // A caller may not have queued yet; the idle timer bounds an unused peer.
    if (waiter) grant(entry, waiter);
    else armIdleTimer(entry);
  }

  function armIdleTimer(entry: Entry<P>) {
    if (entry.timers.idle !== undefined) {
      options.clearTimer(entry.timers.idle);
      entry.timers.idle = undefined;
    }
    const delay = Math.max(
      0,
      limits.idleMs - (options.now() - entry.lastUsedAt),
    );
    entry.timers.idle = options.setTimer(() => {
      entry.timers.idle = undefined;
      if (entry.busy || entry.waiters.length > 0) return;
      retireEntry(entry);
    }, delay);
  }

  function grant(entry: Entry<P>, waiter: Waiter<P>) {
    if (waiter.done) return;
    waiter.done = true;
    waiter.detach();
    const index = entry.waiters.indexOf(waiter);
    if (index >= 0) entry.waiters.splice(index, 1);
    entry.busy = true;
    entry.state = 'busy';
    entry.holder = waiter.op;
    waiter.op.entry = entry;
    waiter.resolve(entry);
  }

  function enqueue(
    entry: Entry<P>,
    op: Operation<P>,
  ): Promise<Entry<P> | undefined> {
    return new Promise<Entry<P> | undefined>((resolve, reject) => {
      const waiter: Waiter<P> = {
        op,
        resolve,
        reject,
        done: false,
        detach: () => undefined,
      };
      const onAbort = () => {
        if (waiter.done) return;
        waiter.done = true;
        const index = entry.waiters.indexOf(waiter);
        if (index >= 0) entry.waiters.splice(index, 1);
        reject(operationFault(op));
        if (entry.state === 'starting' && entry.waiters.length === 0)
          cancelStartup(entry);
      };
      waiter.detach = () => op.signal.removeEventListener('abort', onAbort);
      if (op.signal.aborted) {
        onAbort();
        return;
      }
      op.signal.addEventListener('abort', onAbort, { once: true });
      entry.waiters.push(waiter);
      if (entry.state === 'ready' && !entry.busy) grant(entry, waiter);
    });
  }

  // Waits for the disposal of an evicted entry, bounded by the operation.
  function raceAbort(op: Operation<P>, work: Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      if (op.signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        op.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      op.signal.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        op.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      void work.then(done, done);
    });
  }

  // The least recently used idle entry that may be retired for a free slot.
  function evictionCandidate(): Entry<P> | undefined {
    let best: Entry<P> | undefined;
    for (const entry of live) {
      if (entry.state !== 'ready' || entry.busy || entry.waiters.length > 0)
        continue;
      if (!best || entry.lastUsedAt < best.lastUsedAt) best = entry;
    }
    return best;
  }

  async function ensureCapacity(op: Operation<P>) {
    while (live.size >= limits.capacity) {
      const victim = evictionCandidate();
      if (!victim) throw fault('dependency_unavailable');
      retireEntry(victim);
      const disposal = victim.disposal;
      if (!disposal) continue;
      await raceAbort(op, disposal);
      if (op.signal.aborted) throw operationFault(op);
    }
  }

  async function obtainEntry(op: Operation<P>, key: string): Promise<Entry<P>> {
    for (;;) {
      if (closed) throw fault('dependency_unavailable');
      const existing = serving.get(key);
      if (existing) return existing;
      await ensureCapacity(op);
      if (op.signal.aborted) throw operationFault(op);
      if (closed) throw fault('dependency_unavailable');
      const again = serving.get(key);
      if (again) return again;
      // Another operation may have taken the slot while the eviction waited.
      if (live.size >= limits.capacity) continue;
      const entry = createEntry(key);
      serving.set(key, entry);
      live.add(entry);
      op.fresh = true;
      beginStartup(entry);
      return entry;
    }
  }

  async function acquire(op: Operation<P>, key: string): Promise<Entry<P>> {
    for (;;) {
      if (closed) throw fault('dependency_unavailable');
      const entry = await obtainEntry(op, key);
      if (entry.failed) throw fault('dependency_unavailable');
      if (entry.disposal || entry.invalidated || entry.state === 'retiring')
        continue;
      const granted = await enqueue(entry, op);
      if (granted) return granted;
    }
  }

  function release(op: Operation<P>, entry: Entry<P>) {
    if (entry.holder === op) entry.holder = undefined;
    if (!entry.busy) return;
    entry.busy = false;
    entry.lastUsedAt = options.now();
    if (entry.invalidated || entry.disposal) return;
    if (entry.state === 'retiring') {
      void disposeEntry(entry);
      return;
    }
    entry.state = 'ready';
    const waiter = entry.waiters.shift();
    if (waiter) {
      grant(entry, waiter);
      return;
    }
    armIdleTimer(entry);
  }

  function createLease(op: Operation<P>, entry: Entry<P>): OperationLease<P> {
    const state: LeaseState<P> = {
      entry,
      generation: entry.generation,
      admitted: false,
      admittedEntry: undefined,
    };
    return {
      get peer() {
        return state.entry.peer as P;
      },
      get generation() {
        return state.entry.generation;
      },
      get fresh() {
        return op.fresh;
      },
      get signal() {
        return op.signal;
      },
      async request<T>(
        seq: number,
        admission: boolean,
        send: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> {
        const current = state.entry;
        // The final gate is synchronous: no await between it and `send`.
        let expired = false;
        let allowed = true;
        if (current.holder !== op || current.generation !== state.generation)
          allowed = false;
        else if (current.invalidated || current.state === 'disposing')
          allowed = false;
        else if (op.signal.aborted) allowed = false;
        else if (admission) {
          if (
            serving.get(current.key) !== current ||
            current.state === 'retiring'
          )
            allowed = false;
          else if (options.now() >= current.startedAt + limits.maxLifeMs) {
            allowed = false;
            expired = true;
          }
        } else if (!state.admitted || state.admittedEntry !== current)
          allowed = false;
        if (!allowed) {
          // Only the max-life clock check failed: retire, do not invalidate.
          if (expired) retireEntry(current);
          else invalidateEntry(current);
          throw fault('dependency_unavailable');
        }
        current.validatedSeq = seq;
        if (admission) {
          state.admitted = true;
          state.admittedEntry = current;
        }
        const controller = new AbortController();
        let cancelled = false;
        // Cancellation or the deadline reaching a dispatched request ends the
        // peer at once: the server may keep working, so it is never reused.
        const forward = () => {
          cancelled = true;
          controller.abort();
          invalidateEntry(current);
        };
        op.signal.addEventListener('abort', forward, { once: true });
        try {
          const result = await send(controller.signal);
          // A result produced after an invalidation is discarded.
          if (cancelled) throw operationFault(op);
          if (current.invalidated) throw fault('dependency_unavailable');
          return result;
        } catch (error) {
          if (cancelled || op.signal.aborted) {
            invalidateEntry(current);
            throw operationFault(op);
          }
          if (terminal(error)) invalidateEntry(current);
          throw error instanceof RuntimeFault
            ? error
            : fault('dependency_unavailable');
        } finally {
          op.signal.removeEventListener('abort', forward);
        }
      },
      async replace() {
        const previous = state.entry;
        // The old entry accepts no new operation and frees its own slot.
        retireEntry(previous);
        previous.busy = false;
        previous.holder = undefined;
        const disposal = disposeEntry(previous);
        await raceAbort(op, disposal);
        if (op.signal.aborted) throw operationFault(op);
        // Join the serving entry or start one, like any other operation.
        op.fresh = false;
        const next = await acquire(op, previous.key);
        state.entry = next;
        state.generation = next.generation;
        state.admitted = false;
        state.admittedEntry = undefined;
      },
      invalidate() {
        invalidateEntry(state.entry);
      },
    };
  }

  return {
    async use<T>(
      key: string,
      signal: AbortSignal,
      deadlineMs: number,
      operation: (lease: OperationLease<P>) => Promise<T>,
    ): Promise<T> {
      if (closed) throw fault('dependency_unavailable');
      const op = createOperation(signal, deadlineMs);
      try {
        const entry = await acquire(op, key);
        const lease = createLease(op, entry);
        try {
          const result = await operation(lease);
          // Invalidation during result handling discards the result.
          if (op.invalidated) throw fault('dependency_unavailable');
          return result;
        } catch (error) {
          if (terminal(error) && op.entry) invalidateEntry(op.entry);
          throw error;
        } finally {
          release(op, op.entry ?? entry);
        }
      } finally {
        cleanupOperation(op);
      }
    },
    invalidate(key: string | 'all') {
      for (const entry of [...live]) {
        if (key === 'all' || entry.key === key) invalidateEntry(entry);
      }
    },
    retire(key: string | 'all') {
      for (const entry of [...live]) {
        if (key === 'all' || entry.key === key) retireEntry(entry);
      }
    },
    reconcile(
      seq: number,
      decide: (entry: EntryInfo) => 'keep' | 'retire' | 'invalidate',
    ) {
      // A starting entry is authorised by its own startup snapshot and by
      // dispatch validation before its first request.
      const targets = [...live].filter(
        (entry) => entry.state !== 'starting' && entry.validatedSeq < seq,
      );
      const decisions = targets.map((entry) => ({
        entry,
        decision: decide(toInfo(entry)),
      }));
      for (const { entry, decision } of decisions) {
        if (decision === 'retire') retireEntry(entry);
        else if (decision === 'invalidate') invalidateEntry(entry);
      }
    },
    close(deadlineMs: number): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const entry of [...live]) invalidateEntry(entry);
      const disposals = [...live]
        .map((entry) => entry.disposal)
        .filter((value): value is Promise<void> => value !== undefined);
      let handle: unknown;
      const deadline = new Promise<void>((resolve) => {
        handle = options.setTimer(resolve, deadlineMs);
      });
      const promise = Promise.race([Promise.all(disposals), deadline]).then(
        () => undefined,
      );
      closing = promise;
      void promise.then(() => options.clearTimer(handle));
      return promise;
    },
    get size() {
      return live.size;
    },
  };
}
