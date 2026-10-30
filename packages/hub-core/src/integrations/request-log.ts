import { randomUUID } from 'node:crypto';
import { ToolCallRecordSchema, type ToolCallRecord } from '@waleed/contracts';

export const REQUEST_LOG_CAPACITY = 500;
const retentionMs = 24 * 60 * 60_000;
export function createRequestLog(
  options: {
    now?: () => number;
    monotonic?: () => number;
    onRecord?: (record: ToolCallRecord) => void | Promise<void>;
  } = {},
) {
  const now = options.now ?? Date.now,
    monotonic = options.monotonic ?? (() => performance.now());
  const ring: Array<ToolCallRecord | undefined> = Array(REQUEST_LOG_CAPACITY);
  let cursor = 0,
    count = 0;
  const values = () =>
    Array.from(
      { length: count },
      (_, index) =>
        ring[
          (cursor - count + index + REQUEST_LOG_CAPACITY) % REQUEST_LOG_CAPACITY
        ]!,
    ).filter(Boolean);
  const prune = () => {
    const all = values(),
      kept = all.filter(
        (record) =>
          Date.parse(record.timestamp) >= now() - retentionMs &&
          Date.parse(record.timestamp) <= now() + 5 * 60_000,
      );
    if (kept.length !== all.length) {
      ring.fill(undefined);
      cursor = 0;
      count = 0;
      for (const record of kept) {
        ring[cursor++] = record;
        count++;
      }
      cursor %= REQUEST_LOG_CAPACITY;
    }
  };
  const append = (raw: unknown, notify = true) => {
    const parsed = ToolCallRecordSchema.safeParse(raw);
    if (!parsed.success) return false;
    prune();
    const record = parsed.data,
      time = Date.parse(record.timestamp);
    if (
      time < now() - retentionMs ||
      time > now() + 5 * 60_000 ||
      values().some((existing) => existing.id === record.id)
    )
      return false;
    ring[cursor] = record;
    cursor = (cursor + 1) % REQUEST_LOG_CAPACITY;
    count = Math.min(count + 1, REQUEST_LOG_CAPACITY);
    if (notify && options.onRecord) {
      try {
        void Promise.resolve(options.onRecord(structuredClone(record))).catch(
          () => undefined,
        );
      } catch {
        /* Observational logging never replays or changes an invocation. */
      }
    }
    return true;
  };
  return {
    append,
    records() {
      prune();
      return structuredClone(values().reverse());
    },
    clear() {
      ring.fill(undefined);
      cursor = 0;
      count = 0;
    },
    begin(agentId: ToolCallRecord['agentId']) {
      const timestamp = new Date(now()).toISOString(),
        started = monotonic();
      let finished = false;
      return {
        finish(
          metadata: Pick<
            ToolCallRecord,
            'connectorId' | 'toolName' | 'status' | 'resultSizeBytes'
          >,
        ) {
          if (finished) return;
          finished = true;
          // Project named scalars explicitly: no args, result, error, or caller
          // object spread can enter the retained record or its optional IPC sink.
          append({
            id: randomUUID(),
            timestamp,
            agentId,
            connectorId: metadata.connectorId,
            toolName: metadata.toolName,
            durationMs: Math.max(
              0,
              Math.min(
                Number.MAX_SAFE_INTEGER,
                Math.round(monotonic() - started),
              ),
            ),
            resultSizeBytes: metadata.resultSizeBytes,
            status: metadata.status,
          });
        },
      };
    },
  };
}
export type RequestLog = ReturnType<typeof createRequestLog>;
