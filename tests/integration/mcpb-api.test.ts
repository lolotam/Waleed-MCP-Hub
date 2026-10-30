import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createMcpbAdapter,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from '../helpers/memory-store.js';
import { memorySecrets } from '../helpers/secrets.js';
import { mcpb } from '../helpers/mcpb.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\mcpb-api-');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const secrets = memorySecrets(),
    lifecycle = createLifecycle(
      memoryStore(),
      Date.now,
      createMemorySafetyLedger(),
      {
        secrets: { windows: secrets.backend },
        bundles: createMcpbAdapter(directory, { node: process.execPath }),
      },
    );
  const server = await createHubServer({ port: 4177, lifecycle });
  cleanups.push(async () => {
    await server.app.close();
    secrets.close();
  });
  const base = { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' },
    session = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: base,
      payload: { token: server.issueLaunchToken() },
    });
  const headers = {
    ...base,
    cookie: session.headers['set-cookie']!.toString().split(';')[0]!,
    'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
  };
  return { server, lifecycle, directory, secrets, headers };
}
it('guards binary uploads by session, Origin and CSRF before inspecting bytes', async () => {
  const f = await setup(),
    upload = { 'content-type': 'application/octet-stream' };
  for (const headers of [
    { host: f.headers.host, origin: f.headers.origin, ...upload },
    { ...f.headers, ...upload, 'x-csrf-token': 'bad' },
    { ...f.headers, ...upload, origin: 'https://foreign.test' },
  ]) {
    const response = await f.server.app.inject({
      method: 'POST',
      url: '/api/bundles/preview',
      headers,
      payload: mcpb(),
    });
    expect([401, 403]).toContain(response.statusCode);
  }
  expect(await readdir(f.directory)).toEqual([]);
});
it('uploads above the ordinary JSON limit, keeps install owner-scoped, and never returns credentials', async () => {
  const f = await setup();
  const response = await f.server.app.inject({
    method: 'POST',
    url: '/api/bundles/preview',
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: mcpb(undefined, [
      {
        name: 'payload.txt',
        data: Buffer.from(
          Array.from({ length: 90000 }, (_, index) =>
            String.fromCharCode(32 + ((index * 31) % 90)),
          ).join(''),
        ),
        method: 0,
      },
    ]),
  });
  expect(response.statusCode).toBe(200);
  const preview = response.json<{ id: string }>();
  const second = await f.server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host: f.headers.host, origin: f.headers.origin },
    payload: { token: f.server.issueLaunchToken() },
  });
  const denied = await f.server.app.inject({
    method: 'POST',
    url: `/api/bundles/${preview.id}/install`,
    headers: {
      ...f.headers,
      cookie: second.headers['set-cookie']!.toString().split(';')[0]!,
      'x-csrf-token': second.json<{ csrfToken: string }>().csrfToken,
    },
    payload: {
      expectedRevision: 0,
      configuration: { token: 'SYNTHETIC-OTHER-OWNER-PRIVATE' },
      confirmInstall: true,
    },
  });
  expect(denied.statusCode).toBe(404);
  const secret = 'SYNTHETIC-MCPB-API-PRIVATE',
    installed = await f.server.app.inject({
      method: 'POST',
      url: `/api/bundles/${preview.id}/install`,
      headers: f.headers,
      payload: {
        expectedRevision: 0,
        configuration: { token: secret, count: 2, enabled: false },
        confirmInstall: true,
      },
    });
  expect(installed.statusCode).toBe(200);
  expect(installed.json()).toMatchObject({
    state: 'saved',
    requiresApproval: true,
  });
  expect(
    JSON.stringify([installed.json(), await f.lifecycle.inventory()]),
  ).not.toContain(secret);
  expect(
    f.secrets.writes.every((bytes) => bytes.every((value) => value === 0)),
  ).toBe(true);
  const replay = await f.server.app.inject({
    method: 'POST',
    url: `/api/bundles/${preview.id}/install`,
    headers: f.headers,
    payload: { expectedRevision: 1, configuration: {}, confirmInstall: true },
  });
  expect(replay.statusCode).toBe(404);
});
it('leaves the 64 KiB JSON limit intact, bounds binary uploads, and reports malformed archives without echo', async () => {
  const f = await setup(),
    secret = 'SYNTHETIC-MALFORMED-ARCHIVE-PRIVATE';
  for (const payload of [
    Buffer.from(secret),
    Buffer.alloc(25 * 1024 * 1024 + 1),
  ]) {
    const response = await f.server.app.inject({
      method: 'POST',
      url: '/api/bundles/preview',
      headers: { ...f.headers, 'content-type': 'application/octet-stream' },
      payload,
    });
    expect([400, 413]).toContain(response.statusCode);
    expect(response.body).not.toContain(secret);
  }
  const response = await f.server.app.inject({
    method: 'POST',
    url: '/api/imports/preview',
    headers: f.headers,
    payload: { source: 'x'.repeat(70 * 1024), expectedRevision: 0 },
  });
  expect(response.statusCode).toBe(413);
});
