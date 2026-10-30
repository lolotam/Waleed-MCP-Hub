import { afterEach, describe, expect, it } from 'vitest';
import { createLifecycle, createMemorySafetyLedger } from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from '../helpers/memory-store.js';
import { profileState } from '../helpers/runtime.js';
import { memorySecrets } from '../helpers/secrets.js';

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of running.splice(0)) await close();
});
async function setup() {
  const secrets = memorySecrets();
  const safety = createMemorySafetyLedger();
  const lifecycle = createLifecycle(
    memoryStore(profileState(['remote'])),
    Date.now,
    safety,
    { secrets: { windows: secrets.backend } },
  );
  const server = await createHubServer({ port: 4177, lifecycle });
  running.push(async () => {
    await server.app.close();
    secrets.close();
  });
  const host = '127.0.0.1:4177',
    origin = `http://${host}`;
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host, origin },
    payload: { token: server.issueLaunchToken() },
  });
  const headers = {
    host,
    origin,
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': response.json<{ csrfToken: string }>().csrfToken,
  };
  return { server, headers, lifecycle, safety, secrets };
}
const privateValue = 'SYNTHETIC-ONE-WAY-HTTP-0123456789';
const payload = () => ({
  expectedRevision: 0,
  expectedConnectorRevision: 1,
  location: 'header',
  name: 'Authorization',
  format: 'bearer',
  adapter: 'windows',
  value: privateValue,
});
describe('protected one-way credential HTTP interface', () => {
  it('returns presence/IDs only; inventory, diagnostics, errors and recovery never return credential values', async () => {
    const { server, headers, secrets, safety } = await setup();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/connectors/connector-0/credentials',
      headers,
      payload: payload(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: expect.stringMatching(/^wmh-secret-/),
      present: true,
      requiresApproval: true,
    });
    expect(response.body).not.toContain(privateValue);
    for (const url of [
      '/api/connectors',
      '/api/credentials',
      '/api/connectors/connector-0/auth',
      '/api/profiles',
      '/api/activity',
      '/api/recovery',
      '/api/bootstrap',
    ]) {
      const read = await server.app.inject({ url, headers });
      expect(read.statusCode).toBe(200);
      expect(read.body).not.toContain(privateValue);
    }
    const invalid = await server.app.inject({
      method: 'POST',
      url: '/api/connectors/connector-0/credentials',
      headers,
      payload: { ...payload(), unexpected: privateValue },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(privateValue);
    expect(JSON.stringify(await safety.read())).not.toContain(privateValue);
    expect(
      secrets.writes.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
    expect(
      (
        await server.app.inject({
          url: '/api/connectors/connector-0/credentials',
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('requires session, exact origin and CSRF before secret writes or OAuth; no generic value-read/revoke route exists', async () => {
    const { server, headers, secrets } = await setup();
    for (const url of [
      '/api/connectors/connector-0/credentials',
      '/api/connectors/connector-0/oauth',
      '/api/connectors/connector-0/oauth/discover',
      '/api/connectors/connector-0/oauth/disconnect',
    ]) {
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url,
            headers: { host: headers.host, origin: headers.origin },
            payload: payload(),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url,
            headers: {
              host: headers.host,
              origin: headers.origin,
              cookie: headers.cookie,
            },
            payload: payload(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url,
            headers: { ...headers, origin: 'https://foreign.test' },
            payload: payload(),
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(secrets.values.size).toBe(0);
    expect(
      (
        await server.app.inject({
          url: '/api/credentials/arbitrary/value',
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/connectors/connector-0/oauth/revoke',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it('lists connected accounts without a token-read endpoint and validates explicit disconnect/discovery consent', async () => {
    const { server, headers, secrets } = await setup();
    const accounts = await server.app.inject({
      url: '/api/oauth/accounts',
      headers,
    });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json()).toEqual({ revision: 0, accounts: [] });
    expect(
      (
        await server.app.inject({
          url: '/api/oauth/accounts',
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(401);
    for (const action of ['discover', 'disconnect']) {
      const denied = await server.app.inject({
        method: 'POST',
        url: `/api/connectors/connector-0/oauth/${action}`,
        headers,
        payload: { expectedRevision: 0, expectedConnectorRevision: 1 },
      });
      expect(denied.statusCode).toBe(400);
    }
    expect(secrets.reads).toEqual([]);
    expect(secrets.values.size).toBe(0);
  });
  it('rejects stale editors and shared credential deletion; a saved credential is not reported connected', async () => {
    const { server, headers } = await setup();
    const saved = await server.app.inject({
      method: 'POST',
      url: '/api/connectors/connector-0/credentials',
      headers,
      payload: payload(),
    });
    const id = saved.json<{ id: string }>().id;
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/connectors/connector-0/credentials',
          headers,
          payload: payload(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/credentials/${id}/delete`,
          headers,
          payload: { expectedRevision: 1, confirmLocalDeletion: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.app.inject({
          url: '/api/connectors/connector-0/auth',
          headers,
        })
      ).json(),
    ).toMatchObject({ state: 'untested', localDeletionRevokesProvider: false });
  });
});
