import { afterEach, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import { createLifecycle } from '@waleed/hub-core';
import { memoryStore } from '../helpers/memory-store.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const hub = createLifecycle(memoryStore()),
    server = await createHubServer({ port: 4177, lifecycle: hub });
  cleanup.push(async () => {
    await server.app.close();
    await hub.close();
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
  return { hub, server, base, headers };
}
it('queries onboarding without mutations and applies only revision-checked preference updates', async () => {
  const f = await fixture(),
    get = () =>
      f.server.app.inject({
        method: 'GET',
        url: '/api/settings/onboarding',
        headers: f.headers,
      });
  expect((await get()).json()).toEqual({
    revision: 0,
    onboardingCompleted: false,
  });
  expect((await f.hub.inventory()).revision).toBe(0);
  const saved = await f.server.app.inject({
    method: 'POST',
    url: '/api/settings/onboarding',
    headers: f.headers,
    payload: { expectedRevision: 0, onboardingCompleted: true },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ revision: 1, onboardingCompleted: true });
  expect(
    (
      await f.server.app.inject({
        method: 'POST',
        url: '/api/settings/onboarding',
        headers: f.headers,
        payload: { expectedRevision: 0, onboardingCompleted: false },
      })
    ).statusCode,
  ).toBe(409);
  expect((await get()).json().onboardingCompleted).toBe(true);
  expect((await f.hub.inventory()).revision).toBe(0);
  expect(await f.hub.settings.preferences()).toMatchObject({
    backgroundHealthChecks: false,
    keepRunningInTray: true,
  });
});
it('retains exact session, Origin, CSRF and fixed metadata-only refusal contracts', async () => {
  const f = await fixture();
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: '/api/settings/onboarding',
        headers: f.base,
      })
    ).statusCode,
  ).toBe(401);
  for (const headers of [
    { ...f.headers, origin: 'https://foreign.test' },
    { ...f.headers, 'x-csrf-token': 'bad' },
  ])
    expect(
      (
        await f.server.app.inject({
          method: 'POST',
          url: '/api/settings/onboarding',
          headers,
          payload: { expectedRevision: 0, onboardingCompleted: true },
        })
      ).statusCode,
    ).toBe(403);
  const response = await f.server.app.inject({
    method: 'POST',
    url: '/api/settings/onboarding',
    headers: f.headers,
    payload: {
      expectedRevision: 0,
      onboardingCompleted: true,
      command: 'SYNTHETIC-NEVER-LOG',
    },
  });
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain('SYNTHETIC-NEVER-LOG');
  expect(JSON.stringify(await f.hub.safety.read())).not.toContain(
    'SYNTHETIC-NEVER-LOG',
  );
  expect((await f.hub.settings.onboarding()).onboardingCompleted).toBe(false);
});
