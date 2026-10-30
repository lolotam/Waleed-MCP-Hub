import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ToolCallRecordSchema,
  PlaygroundInvokeRequestSchema,
} from '@waleed/contracts';
import { createRequestLog } from '@waleed/hub-core';
const record = () => ({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  agentId: 'cursor' as const,
  connectorId: 'connector',
  toolName: 'read',
  durationMs: 12,
  resultSizeBytes: 42,
  status: 'success' as const,
});
it('projects exactly the safe record scalars, never caller arguments, responses or errors', () => {
  const sink: unknown[] = [],
    log = createRequestLog({
      onRecord: (value) => {
        sink.push(value);
      },
    }),
    trace = log.begin('cursor');
  const metadata = {
    connectorId: 'connector',
    toolName: 'read',
    status: 'success' as const,
    resultSizeBytes: 10,
    arguments: { token: 'SYNTHETIC-PRIVATE-ARGS' },
    result: 'SYNTHETIC-PRIVATE-RESULT',
    error: new Error('SYNTHETIC-PRIVATE-ERROR'),
  };
  trace.finish(metadata);
  trace.finish(metadata);
  expect(log.records()).toHaveLength(1);
  expect(Object.keys(log.records()[0]!).sort()).toEqual(
    [
      'id',
      'timestamp',
      'agentId',
      'connectorId',
      'toolName',
      'durationMs',
      'resultSizeBytes',
      'status',
    ].sort(),
  );
  expect(JSON.stringify([log.records(), sink])).not.toContain(
    'SYNTHETIC-PRIVATE',
  );
  expect(
    ToolCallRecordSchema.safeParse({
      ...record(),
      arguments: metadata.arguments,
    }).success,
  ).toBe(false);
  expect(log.append({ ...record(), result: metadata.result })).toBe(false);
});
it('evicts the oldest entries FIFO at exactly 500 and clones returned records', () => {
  const log = createRequestLog(),
    ids: string[] = [];
  for (let i = 0; i < 510; i++) {
    const value = record();
    ids.push(value.id);
    expect(log.append(value)).toBe(true);
  }
  const records = log.records();
  expect(records).toHaveLength(500);
  expect(records.map((item) => item.id)).toEqual(ids.slice(10).reverse());
  records[0]!.toolName = 'tampered';
  expect(log.records()[0]!.toolName).toBe('read');
  log.clear();
  expect(log.records()).toEqual([]);
});
it('measures monotonic duration, uses caller-measured byte sizes, and isolates a failed sink', () => {
  let clock = 100,
    wall = Date.now();
  const log = createRequestLog({
      now: () => wall,
      monotonic: () => clock,
      onRecord: () => {
        throw new Error('private');
      },
    }),
    trace = log.begin('hub_playground');
  clock += 12.6;
  wall -= 1000;
  trace.finish({
    connectorId: 'connector',
    toolName: 'read',
    status: 'error',
    resultSizeBytes: Buffer.byteLength('عربي'),
  });
  expect(log.records()[0]).toMatchObject({
    durationMs: 13,
    resultSizeBytes: 8,
    status: 'error',
    agentId: 'hub_playground',
  });
});
it('prunes expired/future entries and rejects duplicate IDs or invalid scalar fields', () => {
  let now = Date.now();
  const log = createRequestLog({ now: () => now }),
    value = record();
  expect(log.append(value)).toBe(true);
  expect(log.append(value)).toBe(false);
  for (const invalid of [
    { durationMs: -1 },
    { resultSizeBytes: 0.5 },
    { toolName: 'unsafe value' },
    { timestamp: 'invalid' },
    { agentId: 'unknown' },
    { status: 'okay' },
  ])
    expect(log.append({ ...record(), ...invalid })).toBe(false);
  expect(
    log.append({
      ...record(),
      timestamp: new Date(now + 600_000).toISOString(),
    }),
  ).toBe(false);
  now += 24 * 60 * 60_000 + 1;
  expect(log.records()).toEqual([]);
});
it.each([undefined, false, 'true', 1])(
  'requires literal true execution confirmation, not %j',
  (confirmExecute) => {
    expect(
      PlaygroundInvokeRequestSchema.safeParse({
        connectorId: 'connector',
        toolName: 'read',
        confirmExecute,
      }).success,
    ).toBe(false);
  },
);
it('accepts explicit confirmation but rejects unsupported fields and dangerous raw argument keys', () => {
  const input = {
    connectorId: 'connector',
    toolName: 'read',
    confirmExecute: true,
  };
  expect(PlaygroundInvokeRequestSchema.safeParse(input).success).toBe(true);
  expect(
    PlaygroundInvokeRequestSchema.safeParse({
      ...input,
      arguments: JSON.parse('{"__proto__":"private"}'),
    }).success,
  ).toBe(false);
  expect(
    PlaygroundInvokeRequestSchema.safeParse({ ...input, secret: 'private' })
      .success,
  ).toBe(false);
});
