import { afterEach, describe, expect, it } from 'vitest';
import {
  createLifecycle,
  createSafetyLedger,
  emptySafetyState,
  HubError,
} from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from '../helpers/memory-store.js';

const running: Awaited<ReturnType<typeof createHubServer>>[] = [];
const host = '127.0.0.1:4177';
const origin = `http://${host}`;
async function setup() {
  const hub = await createHubServer({
    port: 4177,
    lifecycle: createLifecycle(memoryStore()),
  });
  running.push(hub);
  return hub;
}
async function login(hub: Awaited<ReturnType<typeof setup>>) {
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host, origin },
    payload: { token: hub.issueLaunchToken() },
  });
  return {
    host,
    origin,
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': response.json<{ csrfToken: string }>().csrfToken,
  };
}
afterEach(async () => {
  for (const hub of running.splice(0)) await hub.app.close();
});

describe('refusal audit API', () => {
  it('protects audit/recovery reads and records only reviewed route/method/reason/status metadata', async () => {
    const hub = await setup();
    for (const url of ['/api/security-activity', '/api/recovery'])
      expect(
        (await hub.app.inject({ url, headers: { host } })).statusCode,
      ).toBe(401);
    const headers = await login(hub);
    const marker = 'SYNTHETIC-PRIVATE-CANARY';
    await hub.app.inject({
      method: 'POST',
      url: '/api/operations/preview?token=' + marker,
      headers: {
        ...headers,
        origin: `https://${marker}.test`,
        authorization: 'Bearer ' + marker,
      },
      payload: { name: marker },
    });
    await hub.app.inject({
      method: 'POST',
      url: '/api/operations/preview',
      headers,
      payload: { kind: marker },
    });
    await hub.app.inject({ url: '/api/jobs/' + marker.toLowerCase(), headers });
    const audit = await hub.app.inject({
      url: '/api/security-activity',
      headers,
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).not.toContain(marker);
    expect(audit.body).not.toContain(marker.toLowerCase());
    expect(audit.body).not.toContain(headers.cookie);
    expect(audit.body).not.toContain(headers['x-csrf-token']);
    const events = audit.json<{
      events: Array<{ route: string; reason: string }>;
    }>().events;
    expect(events).toContainEqual(
      expect.objectContaining({ route: 'preview', reason: 'origin_denied' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ route: 'preview', reason: 'invalid_input' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ route: 'job', reason: 'not_found' }),
    );
    expect(
      (await hub.app.inject({ url: '/api/recovery', headers })).json(),
    ).toEqual({ blocked: false, operations: [] });
  });
  it('never echoes sensitive exception text, even in typed domain errors', async () => {
    const store = memoryStore();
    store.read = async () => {
      throw new HubError('invalid', 'SYNTHETIC-SENSITIVE-EXCEPTION');
    };
    const hub = await createHubServer({
      port: 4177,
      lifecycle: createLifecycle(store),
    });
    running.push(hub);
    const headers = await login(hub);
    const response = await hub.app.inject({ url: '/api/connectors', headers });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('SYNTHETIC-SENSITIVE-EXCEPTION');
  });
  it('reports failed audit storage explicitly instead of claiming a recorded refusal', async () => {
    const ledger = createSafetyLedger(emptySafetyState(), {
      async assertUnchanged() {},
      async save() {
        throw new Error('SYNTHETIC-SENSITIVE-DISK-ERROR');
      },
      async close() {},
    });
    const hub = await createHubServer({
      port: 4177,
      lifecycle: createLifecycle(memoryStore(), Date.now, ledger),
    });
    running.push(hub);
    const response = await hub.app.inject({
      url: '/api/connectors',
      headers: { host },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe('audit_unavailable');
    expect(response.body).not.toContain('SYNTHETIC-SENSITIVE-DISK-ERROR');
  });
});
