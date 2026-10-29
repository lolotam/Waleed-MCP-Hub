import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLifecycle } from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from '../helpers/memory-store.js';

const running: Awaited<ReturnType<typeof createHubServer>>[] = [];
const host = '127.0.0.1:4177';
const origin = `http://${host}`;
async function setup(withAssets = false) {
  const hub = await createHubServer({
    port: 4177,
    lifecycle: createLifecycle(memoryStore()),
    ...(withAssets
      ? { webRoot: fileURLToPath(new URL('../fixtures/web', import.meta.url)) }
      : {}),
  });
  running.push(hub);
  return hub;
}
async function authenticate(hub: Awaited<ReturnType<typeof setup>>) {
  const token = hub.issueLaunchToken();
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host, origin },
    payload: { token },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: response.headers['set-cookie']!.toString().split(';')[0]!,
    csrf: response.json<{ csrfToken: string }>().csrfToken,
    token,
  };
}
afterEach(async () => {
  for (const hub of running.splice(0)) await hub.app.close();
});

describe('local management security', () => {
  it('serves only minimal unauthenticated health and public assets', async () => {
    const { app } = await setup(true);
    expect(
      (await app.inject({ url: '/health', headers: { host } })).json(),
    ).toEqual({ ready: true });
    expect((await app.inject({ url: '/', headers: { host } })).statusCode).toBe(
      200,
    );
    for (const url of [
      '/api/bootstrap',
      '/api/connectors',
      '/api/agents',
      '/api/profiles',
      '/api/activity',
      '/api/settings',
      '/api/session',
      '/api/jobs/test',
      '/api%2fconnectors',
      '/api/connectors/',
    ]) {
      expect((await app.inject({ url, headers: { host } })).statusCode).toBe(
        401,
      );
    }
  });
  it.each([
    'localhost:4177',
    '127.0.0.1:9999',
    'attacker.test:4177',
    '127.0.0.1:4177.attacker.test',
  ])('rejects Host %s', async (foreignHost) => {
    const { app } = await setup();
    expect(
      (await app.inject({ url: '/health', headers: { host: foreignHost } }))
        .statusCode,
    ).toBe(403);
  });
  it('requires exact Origin, blocks null/foreign/cross-site origins, and denies mutation without Origin', async () => {
    const hub = await setup();
    for (const foreign of [
      'null',
      'https://attacker.test',
      'http://localhost:4177',
    ]) {
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/api/session',
            headers: { host, origin: foreign },
            payload: { token: hub.issueLaunchToken() },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/session',
          headers: { host },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hub.app.inject({
          url: '/health',
          headers: { host, 'sec-fetch-site': 'cross-site' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('uses HttpOnly SameSite cookies and rejects CSRF-less or cross-session changes', async () => {
    const hub = await setup();
    const login = await authenticate(hub);
    const headers = { host, origin, cookie: login.cookie };
    const repeated = await hub.app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: login.token },
    });
    expect(repeated.statusCode).toBe(401);
    expect(
      (await hub.app.inject({ url: '/api/session', headers })).json(),
    ).toEqual({ csrfToken: login.csrf });
    const payload = {
      kind: 'create_profile',
      expectedRevision: 0,
      name: 'Test',
      description: '',
    };
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/operations/preview',
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/operations/preview',
          headers: { ...headers, 'x-csrf-token': 'wrong' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/preview',
      headers: { ...headers, 'x-csrf-token': login.csrf },
      payload,
    });
    expect(response.statusCode).toBe(200);
    const other = await authenticate(hub);
    const forbiddenApply = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/apply',
      headers: {
        host,
        origin,
        cookie: other.cookie,
        'x-csrf-token': other.csrf,
      },
      payload: { previewId: response.json<{ id: string }>().id },
    });
    expect(forbiddenApply.statusCode).toBe(404);
    expect(response.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('sets cookie flags, rejects oversized bodies, and does not reflect sensitive input', async () => {
    const hub = await setup();
    const loginResponse = await hub.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token: hub.issueLaunchToken() },
    });
    expect(loginResponse.headers['set-cookie']).toContain('HttpOnly');
    expect(loginResponse.headers['set-cookie']).toContain('SameSite=Strict');
    const login = await authenticate(hub);
    const headers = {
      host,
      origin,
      cookie: login.cookie,
      'x-csrf-token': login.csrf,
    };
    const invalid = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/preview',
      headers,
      payload: { kind: 'SYNTHETIC-SENSITIVE-PAYLOAD' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('SYNTHETIC-SENSITIVE-PAYLOAD');
    const oversized = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/preview',
      headers,
      payload: { data: 'x'.repeat(70_000) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body.length).toBeLessThan(200);
    const logout = await hub.app.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers,
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(
      (await hub.app.inject({ url: '/api/connectors', headers })).statusCode,
    ).toBe(401);
  });
  it('accepts only revision-bound local changes and rejects unsupported operations', async () => {
    const hub = await setup();
    const login = await authenticate(hub);
    const headers = {
      host,
      origin,
      cookie: login.cookie,
      'x-csrf-token': login.csrf,
    };
    const preview = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/preview',
      headers,
      payload: {
        kind: 'create_profile',
        expectedRevision: 0,
        name: 'Integration',
        description: '',
      },
    });
    const apply = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/apply',
      headers,
      payload: { previewId: preview.json<{ id: string }>().id },
    });
    expect(apply.statusCode).toBe(202);
    const id = apply.json<{ id: string }>().id;
    // Drain through app lifecycle close is not needed: setImmediate advances here.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const job = await hub.app.inject({ url: `/api/jobs/${id}`, headers });
    expect(job.json<{ state: string }>().state).toBe('succeeded');
    const profiles = await hub.app.inject({ url: '/api/profiles', headers });
    expect(profiles.json<{ revision: number }>().revision).toBe(1);
    const stale = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/preview',
      headers,
      payload: {
        kind: 'create_profile',
        expectedRevision: 0,
        name: 'Another',
        description: '',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/operations/preview',
          headers,
          payload: { kind: 'execute_command', command: 'anything' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
