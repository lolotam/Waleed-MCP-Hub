import { afterEach, expect, it } from 'vitest';
import { playgroundFixture } from './helpers/playground.js';
import { sanitizePlaygroundOutput } from '../packages/hub-core/src/integrations/playground.js';
const fixtures: ReturnType<typeof playgroundFixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.playground.close();
});
const setup = (options: Parameters<typeof playgroundFixture>[0] = {}) => {
  const f = playgroundFixture(options);
  fixtures.push(f);
  return f;
};
it('catalog loads inert schemas without calling a tool, closes its peer and returns review fingerprints', async () => {
  const f = setup(),
    catalog = await f.playground.catalog({ connectorId: 'connector-0' });
  expect(catalog.tools).toHaveLength(1);
  expect(catalog.tools[0]).toMatchObject({
    name: 'read',
    policy: 'allow',
    schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(f.calls).toEqual([]);
  expect(f.log.records()).toEqual([]);
  expect(f.peers).toEqual({ started: 1, closed: 1 });
});
it('confirmed execution returns owner-scoped temporary output and records only call metadata', async () => {
  const f = setup(),
    result = await f.run({ arguments: { value: 'SYNTHETIC-PRIVATE-INPUT' } });
  expect(result).toMatchObject({
    state: 'succeeded',
    result: {
      isError: false,
      output: expect.stringContaining('synthetic success'),
    },
  });
  expect(f.calls).toHaveLength(1);
  expect(f.peers.started).toBe(f.peers.closed);
  expect(f.log.records()[0]).toMatchObject({
    agentId: 'hub_playground',
    connectorId: 'connector-0',
    toolName: 'read',
    status: 'success',
    resultSizeBytes: Buffer.byteLength(
      JSON.stringify({
        content: [{ type: 'text', text: 'synthetic success' }],
      }),
    ),
  });
  expect(JSON.stringify(f.log.records())).not.toContain(
    'SYNTHETIC-PRIVATE-INPUT',
  );
  expect(() => f.playground.job(result.id, 'other')).toThrow();
  expect(() => f.playground.cancel(result.id, 'other')).toThrow();
});
it('never starts a peer for missing confirmation or unapproved/disabled connectors', async () => {
  const f = setup();
  expect(() =>
    f.playground.invoke({ ...f.input(), confirmExecute: false }, 'owner'),
  ).toThrow();
  f.state.connectors[0]!.trustApproval = null;
  expect((await f.run()).state).toBe('failed');
  expect(f.peers.started).toBe(0);
  expect(f.calls).toEqual([]);
});
it('enforces Block, while Ask consumes an explicit confirmation for each independent call', async () => {
  const f = setup();
  f.state.connectors[0]!.toolPolicies = { read: 'block' };
  expect((await f.run()).state).toBe('failed');
  expect(f.log.records()[0]!.status).toBe('blocked');
  expect(f.calls).toEqual([]);
  f.state.connectors[0]!.toolPolicies = { read: 'ask' };
  expect((await f.run()).state).toBe('succeeded');
  expect((await f.run()).state).toBe('succeeded');
  expect(f.calls).toHaveLength(2);
});
it('refuses stale registry, connector, definition and tool-schema reviews', async () => {
  const f = setup();
  for (const extra of [
    { expectedRevision: 99 },
    { expectedConnectorRevision: 99 },
    { expectedDefinitionHash: '0'.repeat(64) },
    { expectedToolSchemaHash: '0'.repeat(64) },
  ])
    expect((await f.run(extra)).state).toBe('failed');
  expect(f.calls).toEqual([]);
});
it('rechecks state after catalog I/O and does not dispatch after a policy change', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    f = setup({ listGate: gate }),
    job = f.playground.invoke(f.input(), 'owner');
  await new Promise<void>((r) => setTimeout(r, 10));
  f.state.connectors[0]!.toolPolicies = { read: 'block' };
  f.state.revision++;
  release();
  await f.playground.drain();
  expect(f.playground.job(job.id, 'owner').state).toBe('failed');
  expect(f.calls).toEqual([]);
});
it('never copies unknown requested names into request records', async () => {
  const f = setup();
  await f.run({ toolName: 'SYNTHETIC_PRIVATE_UNKNOWN' });
  expect(f.log.records()[0]).toMatchObject({
    connectorId: 'hub_unknown',
    toolName: 'unknown_tool',
    status: 'error',
  });
  expect(JSON.stringify(f.log.records())).not.toContain(
    'SYNTHETIC_PRIVATE_UNKNOWN',
  );
  expect(f.calls).toEqual([]);
});
it('withholds credential echoes and provider error bodies without retaining either', async () => {
  const secret = 'SYNTHETIC-PROTECTED-CREDENTIAL',
    f = setup({
      secret,
      result: { content: [{ type: 'text', text: secret }] },
    }),
    result = await f.run();
  expect(result.state).toBe('failed');
  expect(JSON.stringify([result, f.log.records()])).not.toContain(secret);
  const error = setup({
      result: {
        isError: true,
        content: [{ type: 'text', text: 'SYNTHETIC-PRIVATE-PROVIDER-ERROR' }],
      },
    }),
    failed = await error.run();
  expect(failed.state).toBe('failed');
  expect(JSON.stringify([failed, error.log.records()])).not.toContain(
    'SYNTHETIC-PRIVATE-PROVIDER-ERROR',
  );
  expect(error.log.records()[0]!.status).toBe('error');
});
it('redacts submitted strings, JSON escapes, URL and base64 encodings, and bounds output', () => {
  const value = 'PRIVATE " value / token',
    encoded = Buffer.from(value).toString('base64'),
    output = sanitizePlaygroundOutput(
      {
        content: [{ text: `${value} ${encoded} ${encodeURIComponent(value)}` }],
      },
      { nested: { value } },
    );
  expect(output).toContain('[redacted]');
  expect(output).not.toContain(encoded);
  expect(output).not.toContain(encodeURIComponent(value));
  expect(sanitizePlaygroundOutput({ text: 'yes' }, { value: 'a' })).toContain(
    'withheld',
  );
  expect(
    sanitizePlaygroundOutput({ text: 'x'.repeat(50_000) }, {}).length,
  ).toBeLessThanOrEqual(16384);
});
it('expires completed output after two minutes and clears it on cancellation', async () => {
  let now = Date.now();
  const f = setup({ now: () => now }),
    job = await f.run();
  expect(f.playground.cancel(job.id, 'owner')).toMatchObject({
    state: 'cancelled',
    result: null,
  });
  now += 120001;
  expect(() => f.playground.job(job.id, 'owner')).toThrow();
});
it('cancels in-flight work without replay and closes the owned peer', async () => {
  let called!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      called = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    }),
    f = setup({ callGate: gate, onCall: called }),
    job = f.playground.invoke(f.input(), 'owner');
  await started;
  expect(f.playground.cancel(job.id, 'owner').state).toBe('cancelled');
  release();
  await f.playground.drain();
  expect(f.calls).toHaveLength(1);
  expect(f.peers.started).toBe(f.peers.closed);
  expect(f.playground.job(job.id, 'owner').result).toBeNull();
});
it('rejects oversized arguments and bounds retained jobs', async () => {
  const f = setup();
  expect((await f.run({ arguments: { value: 'x'.repeat(50000) } })).state).toBe(
    'failed',
  );
  expect(f.peers.started).toBe(0);
  for (let i = 0; i < 31; i++) await f.run();
  expect(() => f.playground.invoke(f.input(), 'owner')).toThrow();
});
it('supports reviewed tools beyond the legacy full-catalog limit', async () => {
  const f = setup();
  f.setTools(
    Array.from({ length: 600 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: { type: 'object' },
    })),
  );
  const catalog = await f.playground.catalog({ connectorId: 'connector-0' });
  expect(catalog.tools).toHaveLength(600);
  expect(
    (
      await f.run({
        toolName: 'tool_599',
        expectedToolSchemaHash: catalog.tools[599]!.schemaHash,
      })
    ).state,
  ).toBe('succeeded');
});
