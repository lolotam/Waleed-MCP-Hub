import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createRequestLog } from '@waleed/hub-core';
import {
  startRequestLogServer,
  createRequestLogSender,
  requestLogAddress,
} from '../../packages/hub-core/src/integrations/request-log-ipc.js';
import { profileState } from '../helpers/runtime.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\request-log-ipc-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = profileState(['native']);
  state.integrations = [
    {
      agentId: 'cursor',
      configPath: 'C:\\synthetic\\cursor.json',
      entryHash: '0'.repeat(64),
      syncedRevision: 0,
      updatedAt: new Date().toISOString(),
    },
  ];
  const log = createRequestLog(),
    server = await startRequestLogServer(directory, log, async () => state);
  cleanup.push(() => server.close());
  const sender = createRequestLogSender(directory);
  cleanup.push(() => sender.close());
  return { directory, state, log, sender };
}
const record = () => ({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  agentId: 'cursor' as const,
  connectorId: 'connector-0',
  toolName: 'read',
  durationMs: 5,
  resultSizeBytes: 42,
  status: 'success' as const,
});
async function raw(directory: string, value: string) {
  await new Promise<void>((resolve) => {
    const socket = createConnection(requestLogAddress(directory));
    socket.once('connect', () => socket.end(value));
    socket.once('error', () => resolve());
    socket.once('close', () => resolve());
  });
}
it('collects registered-agent metadata in memory, deduplicates IDs and persists no records', async () => {
  const f = await setup(),
    value = record();
  f.sender.send(value);
  f.sender.send(value);
  await expect.poll(() => f.log.records().length).toBe(1);
  expect(f.log.records()[0]).toEqual(value);
  expect(
    (await readdir(f.directory)).filter((name) => !name.endsWith('.sock')),
  ).toEqual([]);
});
it('drops malformed, extra-field, oversized, unregistered-agent and forged Playground messages', async () => {
  const f = await setup();
  for (const value of [
    'invalid',
    JSON.stringify({ ...record(), arguments: { token: 'SYNTHETIC-PRIVATE' } }),
    JSON.stringify({ ...record(), toolName: 'x'.repeat(3000) }),
    JSON.stringify({ ...record(), agentId: 'codex' }),
    JSON.stringify({ ...record(), agentId: 'hub_playground' }),
  ])
    await raw(f.directory, value);
  await raw(f.directory, JSON.stringify(record()));
  await expect.poll(() => f.log.records().length).toBe(1);
  expect(JSON.stringify(f.log.records())).not.toContain('SYNTHETIC');
});
it('does not fail or replay an invocation when no Hub collector is running', async () => {
  const directory = await mkdtemp(
    'E:\\Dev\\Temp\\opencode\\request-log-missing-',
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const sender = createRequestLogSender(directory);
  for (let i = 0; i < 100; i++) sender.send(record());
  await expect(sender.close()).resolves.toBeUndefined();
});
