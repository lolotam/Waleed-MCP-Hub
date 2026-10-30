import { afterEach, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import { healthFixture } from '../helpers/health.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const f = await healthFixture(),
    server = await createHubServer({ port: 4177, lifecycle: f.hub });
  cleanup.push(async () => {
    await server.app.close();
    await f.close(false);
  });
  const base = { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' },
    session = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: base,
      payload: { token: server.issueLaunchToken() },
    }),
    headers = {
      ...base,
      cookie: session.headers['set-cookie']!.toString().split(';')[0]!,
      'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
    };
  const post = (url: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url, headers, payload });
  return { ...f, server, headers, post };
}
it('protects lifecycle/health mutations with session, exact Origin and CSRF, without unsafe registry input', async () => {
  const f = await setup();
  for (const url of [
    '/api/lifecycle/startup',
    '/api/lifecycle/preferences',
    '/api/health/retest',
  ])
    for (const headers of [
      { host: f.headers.host, origin: f.headers.origin },
      { ...f.headers, origin: 'https://foreign.test' },
      { ...f.headers, 'x-csrf-token': 'bad' },
    ])
      expect([401, 403]).toContain(
        (
          await f.server.app.inject({
            method: 'POST',
            url,
            headers,
            payload: { enabled: true, expectedState: 'disabled' },
          })
        ).statusCode,
      );
  expect(
    (
      await f.post('/api/lifecycle/startup', {
        enabled: true,
        expectedState: 'disabled',
        path: 'C:\\evil.exe',
      })
    ).statusCode,
  ).toBe(400);
  expect(f.startupWrites()).toBe(0);
});
it('reflects startup toggles live and refuses stale/conflicting settings', async () => {
  const f = await setup();
  expect(
    (
      await f.post('/api/lifecycle/startup', {
        enabled: true,
        expectedState: 'disabled',
      })
    ).json(),
  ).toMatchObject({ enabled: true, state: 'enabled' });
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: '/api/lifecycle/startup',
        headers: f.headers,
      })
    ).json(),
  ).toMatchObject({ enabled: true });
  expect(
    (
      await f.post('/api/lifecycle/startup', {
        enabled: false,
        expectedState: 'disabled',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await f.post('/api/lifecycle/startup', {
        enabled: false,
        expectedState: 'enabled',
      })
    ).statusCode,
  ).toBe(200);
  f.setStartupConflict();
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: '/api/lifecycle/startup',
        headers: f.headers,
      })
    ).json(),
  ).toMatchObject({ state: 'conflict' });
  expect(
    (
      await f.post('/api/lifecycle/startup', {
        enabled: true,
        expectedState: 'disabled',
      })
    ).statusCode,
  ).toBe(409);
  expect(f.startupWrites()).toBe(2);
});
it('returns metadata-only health and safely re-tests enabled connectors over live MCP', async () => {
  const f = await setup();
  expect((await f.post('/api/health/retest', {})).statusCode).toBe(200);
  await f.hub.health.drain();
  const result = await f.server.app.inject({
    method: 'GET',
    url: '/api/health/connectors',
    headers: f.headers,
  });
  expect(
    result.json().connectors.map((item: { status: string }) => item.status),
  ).toEqual(['healthy', 'needs_reauth', 'needs_reauth']);
  expect(result.body).not.toContain('SYNTHETIC-HEALTH');
  expect(f.peer.methods).not.toContain('tools/call');
  expect(f.hub.requestLog.records()).toEqual([]);
  expect(
    (
      await f.post('/api/lifecycle/preferences', {
        expectedRevision: 0,
        backgroundHealthChecks: true,
        keepRunningInTray: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await f.post('/api/lifecycle/preferences', {
        expectedRevision: 0,
        backgroundHealthChecks: false,
        keepRunningInTray: true,
      })
    ).statusCode,
  ).toBe(409);
});
