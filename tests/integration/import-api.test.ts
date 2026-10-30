import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import { createLifecycle, emptyState } from '@waleed/hub-core';
import type { ImportPreview } from '@waleed/contracts';
import { memoryStore } from '../helpers/memory-store.js';
import { importSecret, mixedImport } from '../fixtures/imports.js';
import { syntheticConnector } from '../fixtures/native-connector.js';

const hubs: Awaited<ReturnType<typeof createHubServer>>[] = [];
const host = '127.0.0.1:4177';
const origin = `http://${host}`;
async function setup() {
  const store = memoryStore();
  const write = vi.spyOn(store, 'write');
  const lifecycle = createLifecycle(store);
  const hub = await createHubServer({ port: 4177, lifecycle });
  hubs.push(hub);
  return { hub, store, write, lifecycle };
}
async function login(hub: Awaited<ReturnType<typeof createHubServer>>) {
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
const payload = () => ({
  source: JSON.stringify(mixedImport),
  expectedRevision: 0,
});
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.app.close();
});

describe('authenticated no-effects import API', () => {
  it('requires session, local Origin and CSRF before parsing imports', async () => {
    const { hub, write } = await setup();
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/imports/preview',
          headers: { host, origin },
          payload: payload(),
        })
      ).statusCode,
    ).toBe(401);
    const headers = await login(hub);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/imports/preview',
          headers: { host, origin, cookie: headers.cookie },
          payload: payload(),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/imports/preview',
          headers: { ...headers, origin: 'https://foreign.test' },
          payload: payload(),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/imports/preview',
          headers: {
            host,
            cookie: headers.cookie,
            'x-csrf-token': headers['x-csrf-token'],
          },
          payload: payload(),
        })
      ).statusCode,
    ).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });
  it('previews npx/uvx/image/remote data without persistence, provider calls, jobs, or discovery', async () => {
    const { hub, store, write, lifecycle } = await setup();
    const headers = await login(hub);
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/imports/preview',
      headers,
      payload: payload(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const preview = response.json<ImportPreview>();
    expect(preview).toMatchObject({
      applySupported: false,
      selectionReady: true,
      effects: { files: [], processes: 0, networkRequests: 0 },
    });
    expect(response.body).not.toContain(importSecret);
    expect(
      (await hub.app.inject({ url: `/api/imports/${preview.id}`, headers }))
        .body,
    ).toBe(response.body);
    const selection = {
      expectedRevision: 0,
      entries: preview.entries.map(({ key, name, id }) => ({
        key,
        name,
        id,
        selected: false,
      })),
    };
    const changed = await hub.app.inject({
      method: 'POST',
      url: `/api/imports/${preview.id}/selection`,
      headers,
      payload: selection,
    });
    expect(changed.json<ImportPreview>().blockers).toEqual(['no_selection']);
    expect(changed.body).not.toContain(importSecret);
    expect(await store.read()).toEqual(emptyState());
    expect(write).not.toHaveBeenCalled();
    expect((await lifecycle.safety.read()).operations).toEqual([]);
    expect(
      (await hub.app.inject({ url: '/api/discovery', headers })).statusCode,
    ).toBe(503);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/operations/apply',
          headers,
          payload: { previewId: preview.id },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: `/api/imports/${preview.id}/apply`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: `/api/imports/${preview.id}/cancel`,
          headers,
          payload: {},
        })
      ).json(),
    ).toEqual({ discarded: true });
    expect(
      (await hub.app.inject({ url: `/api/imports/${preview.id}`, headers }))
        .statusCode,
    ).toBe(404);
  });
  it('enforces ownership for read/selection/cancel and does not expose raw source or secrets via any inventory', async () => {
    const { hub, lifecycle } = await setup();
    const headers = await login(hub);
    const other = await login(hub);
    const preview = (
      await hub.app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        headers,
        payload: payload(),
      })
    ).json<ImportPreview>();
    for (const path of [
      `/api/imports/${preview.id}`,
      `/api/imports/${preview.id}/selection`,
      `/api/imports/${preview.id}/cancel`,
    ]) {
      const response = await hub.app.inject({
        url: path,
        method: path.endsWith(preview.id) ? 'GET' : 'POST',
        headers: other,
        ...(path.endsWith(preview.id) ? {} : { payload: {} }),
      });
      expect(response.statusCode).toBe(404);
    }
    for (const path of [
      '/api/connectors',
      '/api/profiles',
      '/api/activity',
      '/api/security-activity',
      '/api/recovery',
      `/api/imports/${preview.id}`,
    ]) {
      const response = await hub.app.inject({ url: path, headers });
      expect(response.body).not.toContain(importSecret);
      expect(response.body).not.toContain('"source":');
    }
    expect(JSON.stringify(await lifecycle.safety.read())).not.toContain(
      importSecret,
    );
  });
  it('rejects malformed/oversized/program input without reflecting it or persisting refusal payloads', async () => {
    const { hub, lifecycle, write } = await setup();
    const headers = await login(hub);
    for (const input of [
      { source: `Write-Output ${importSecret}`, expectedRevision: 0 },
      { source: `{${importSecret}`, expectedRevision: 0 },
      { source: 'x'.repeat(49 * 1024), expectedRevision: 0 },
      { ...payload(), extra: importSecret },
      { ...payload(), expectedRevision: -1 },
    ]) {
      const response = await hub.app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        headers,
        payload: input,
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(importSecret);
    }
    const large = await hub.app.inject({
      method: 'POST',
      url: '/api/imports/preview',
      headers,
      payload: { source: importSecret.repeat(3000), expectedRevision: 0 },
    });
    expect(large.statusCode).toBe(413);
    expect(large.body).not.toContain(importSecret);
    const audit = await lifecycle.safety.read();
    expect(JSON.stringify(audit)).not.toContain(importSecret);
    expect(
      audit.securityEvents.some((event) => event.route === 'import_preview'),
    ).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('returns explicit entry errors and conflicts, then accepts a rename/deselect preview decision only', async () => {
    const { hub, store, write } = await setup();
    const state = await store.read();
    state.connectors.push({ ...syntheticConnector, id: 'same', name: 'Same' });
    await store.write(0, state);
    write.mockClear();
    const headers = await login(hub);
    const preview = (
      await hub.app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        headers,
        payload: {
          source: JSON.stringify({
            servers: {
              Same: { id: 'same', command: 'npx', args: ['synthetic'] },
              Unsupported: {
                command: 'uvx',
                args: ['synthetic'],
                cwd: 'not-supported',
              },
            },
          }),
          expectedRevision: 0,
        },
      })
    ).json<ImportPreview>();
    expect(preview.blockers).toEqual(['invalid_selection', 'conflicts']);
    const changes = {
      expectedRevision: 0,
      entries: preview.entries.map(({ key, name, id }) => ({
        key,
        name: name === 'Same' ? 'Renamed' : name,
        id: id === 'same' ? 'renamed' : id,
        selected: name === 'Same',
      })),
    };
    const response = await hub.app.inject({
      method: 'POST',
      url: `/api/imports/${preview.id}/selection`,
      headers,
      payload: changes,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ImportPreview>().selectionReady).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('destroys stale drafts and clears a session draft on logout', async () => {
    const { hub, store } = await setup();
    const headers = await login(hub);
    const preview = (
      await hub.app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        headers,
        payload: payload(),
      })
    ).json<ImportPreview>();
    const state = await store.read();
    state.revision++;
    await store.write(0, state);
    expect(
      (await hub.app.inject({ url: `/api/imports/${preview.id}`, headers }))
        .statusCode,
    ).toBe(409);
    expect(
      (await hub.app.inject({ url: `/api/imports/${preview.id}`, headers }))
        .statusCode,
    ).toBe(404);
    const next = (
      await hub.app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        headers,
        payload: { ...payload(), expectedRevision: 1 },
      })
    ).json<ImportPreview>();
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/session/logout',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await hub.app.inject({ url: `/api/imports/${next.id}`, headers }))
        .statusCode,
    ).toBe(401);
    const newSession = await login(hub);
    expect(
      (
        await hub.app.inject({
          url: `/api/imports/${next.id}`,
          headers: newSession,
        })
      ).statusCode,
    ).toBe(404);
  });
});
