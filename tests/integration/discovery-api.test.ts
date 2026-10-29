import { afterEach, describe, expect, it } from 'vitest';
import { createDiscoveryService, createLifecycle } from '@waleed/hub-core';
import { createHubServer } from '../../apps/server/src/app.js';
import { memoryStore } from '../helpers/memory-store.js';
import { discoveryFixture, privateMarker } from '../fixtures/discovery.js';

const running: Awaited<ReturnType<typeof createHubServer>>[] = [];
const host = '127.0.0.1:4177';
const origin = `http://${host}`;
async function setup() {
  const fixture = discoveryFixture();
  const discovery = createDiscoveryService(fixture.ports, fixture.settings);
  const hub = await createHubServer({
    port: 4177,
    lifecycle: createLifecycle(memoryStore()),
    discovery,
  });
  running.push(hub);
  return { fixture, discovery, hub };
}
async function login(hub: Awaited<ReturnType<typeof setup>>['hub']) {
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

describe('explicit read-only discovery API', () => {
  it('requires session/Origin/CSRF and accepts no executable/path/environment input', async () => {
    const { fixture, hub } = await setup();
    for (const url of [
      '/api/discovery',
      '/api/adoption/preview',
      '/api/discovery/jobs/test',
    ])
      expect(
        (await hub.app.inject({ url, headers: { host } })).statusCode,
      ).toBe(401);
    const headers = await login(hub);
    expect(
      (await hub.app.inject({ url: '/api/discovery', headers })).statusCode,
    ).toBe(200);
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.reads).toHaveLength(0);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/discovery',
          headers: { host, origin, cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/discovery',
          headers,
          payload: {
            executable: 'bad.exe',
            path: 'C:\\private',
            environment: { PASSWORD: privateMarker },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.reads).toHaveLength(0);
  });
  it('returns bounded owner-scoped jobs and a sanitized non-applicable adoption preview', async () => {
    const { fixture, discovery, hub } = await setup();
    const headers = await login(hub);
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/discovery',
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    const id = response.json<{ id: string }>().id;
    await discovery.drain();
    expect(
      (
        await hub.app.inject({ url: `/api/discovery/jobs/${id}`, headers })
      ).json<{ state: string }>().state,
    ).toBe('succeeded');
    const other = await login(hub);
    expect(
      (
        await hub.app.inject({
          url: `/api/discovery/jobs/${id}`,
          headers: other,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: `/api/discovery/jobs/${id}/cancel`,
          headers: other,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const preview = await hub.app.inject({
      url: '/api/adoption/preview',
      headers,
    });
    expect(preview.json()).toMatchObject({
      applySupported: false,
      freshness: 'snapshot_only',
      expectedRevision: 0,
      candidates: expect.any(Array),
    });
    const snapshot = await hub.app.inject({ url: '/api/discovery', headers });
    expect(snapshot.body + preview.body).not.toContain(privateMarker);
    expect(
      (await hub.app.inject({ url: '/api/connectors', headers })).json(),
    ).toEqual({ connectors: [], observations: [] });
    expect(
      (await hub.app.inject({ url: '/api/agents', headers })).json<{
        agents: unknown[];
      }>().agents,
    ).toHaveLength(8);
    expect(
      fixture.calls.every((call) => call.executable.endsWith('docker.exe')),
    ).toBe(true);
  });
  it('does not expose raw exception output or silently replace a failed scan with empty success', async () => {
    const { fixture, discovery, hub } = await setup();
    const headers = await login(hub);
    fixture.ports.read = async () => {
      throw new Error(privateMarker);
    };
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/discovery',
      headers,
      payload: {},
    });
    await discovery.drain();
    const status = await hub.app.inject({
      url: `/api/discovery/jobs/${response.json<{ id: string }>().id}`,
      headers,
    });
    expect(status.json()).toMatchObject({
      state: 'failed',
      reason: 'discovery_failed',
    });
    expect(status.body).not.toContain(privateMarker);
    expect(discovery.snapshot().checkedAt).toBeNull();
  });
});
