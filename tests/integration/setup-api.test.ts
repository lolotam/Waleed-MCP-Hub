import { afterEach, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import {
  createLifecycle,
  emptyState,
  createMemorySafetyLedger,
} from '@waleed/hub-core';
import {
  ExportSetupBundleSchema,
  ImportSetupPreviewSchema,
} from '@waleed/contracts';
import { projectSetup } from '../../packages/hub-core/src/setup/format.js';
import { memoryStore } from '../helpers/memory-store.js';
import { memorySecrets } from '../helpers/secrets.js';
import { profileState } from '../helpers/runtime.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const store = memoryStore(emptyState()),
    vault = memorySecrets(),
    safety = createMemorySafetyLedger(),
    hub = createLifecycle(store, Date.now, safety, {
      secrets: { windows: vault.backend },
    }),
    server = await createHubServer({ port: 4177, lifecycle: hub });
  cleanup.push(async () => {
    await server.app.close();
    await hub.close();
    vault.close();
  });
  const base = { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' };
  async function session() {
    const result = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: base,
      payload: { token: server.issueLaunchToken() },
    });
    return {
      ...base,
      cookie: result.headers['set-cookie']!.toString().split(';')[0]!,
      'x-csrf-token': result.json<{ csrfToken: string }>().csrfToken,
    };
  }
  const headers = await session(),
    bundle = projectSetup(profileState(['native', 'remote']), Date.now());
  bundle.connectors[0]!.requiredSecrets = [
    { key: 'API_KEY', target: 'environment', format: 'raw' },
  ];
  bundle.connectors[1]!.requiredSecrets = [
    { key: 'Authorization', target: 'header', format: 'bearer' },
  ];
  bundle.agentProfileBindings = { cursor: 'profile' };
  const post = (url: string, payload: Record<string, unknown>, h = headers) =>
    server.app.inject({ method: 'POST', url, headers: h, payload });
  return {
    hub,
    server,
    vault,
    safety,
    store,
    headers,
    base,
    bundle,
    post,
    session,
  };
}
it('protects setup routes with session/Origin/CSRF and returns only fixed refusal metadata', async () => {
  const f = await fixture();
  expect(
    (
      await f.server.app.inject({
        method: 'GET',
        url: '/api/setup/export',
        headers: f.base,
      })
    ).statusCode,
  ).toBe(401);
  for (const path of ['/api/setup/import/preview', '/api/setup/import/apply'])
    for (const headers of [
      { ...f.headers, origin: 'https://foreign.test' },
      { ...f.headers, 'x-csrf-token': 'wrong' },
    ])
      expect(
        (await f.post(path, { private: 'SYNTHETIC-DO-NOT-LOG' }, headers))
          .statusCode,
      ).toBe(403);
  const audit = JSON.stringify(await f.safety.read());
  expect(audit).not.toContain('SYNTHETIC-DO-NOT-LOG');
  expect(audit).toContain('setup_import');
});
it('previews and atomically restores credentials/metadata, then downloads a schema-valid secret-free setup', async () => {
  const f = await fixture(),
    response = await f.post('/api/setup/import/preview', {
      source: JSON.stringify(f.bundle),
      conflictStrategy: 'skip_existing',
    });
  expect(response.statusCode).toBe(200);
  const p = ImportSetupPreviewSchema.parse(response.json());
  expect(p.missingSecrets).toHaveLength(2);
  expect(f.vault.values.size).toBe(0);
  const saved = await f.post('/api/setup/import/apply', {
    previewId: p.id,
    expectedRevision: p.expectedRevision,
    conflictStrategy: p.conflictStrategy,
    credentials: {
      'connector-0/environment/API_KEY': 'SYNTHETIC-ENV-KEY',
      'connector-1/header/Authorization': 'SYNTHETIC-AUTH-KEY',
    },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ state: 'saved' });
  expect(f.vault.values.size).toBe(2);
  expect((await f.hub.inventory()).agentProfileBindings).toEqual({
    cursor: 'profile',
  });
  const exported = await f.server.app.inject({
    method: 'GET',
    url: '/api/setup/export',
    headers: f.headers,
  });
  expect(exported.statusCode).toBe(200);
  expect(exported.headers['content-disposition']).toBe(
    'attachment; filename="setup.json"',
  );
  expect(exported.headers['cache-control']).toBe('no-store');
  expect(
    ExportSetupBundleSchema.parse(exported.json()).connectors,
  ).toHaveLength(2);
  for (const secret of [
    'SYNTHETIC-ENV-KEY',
    'SYNTHETIC-AUTH-KEY',
    'wmh-secret-',
    'ciphertext',
  ])
    expect(exported.body).not.toContain(secret);
});
it('rejects malicious source without reflection, isolates owners and revokes setup drafts on logout', async () => {
  const f = await fixture(),
    bad = await f.post('/api/setup/import/preview', {
      source: '{"version":1,"version":1,"private":"SYNTHETIC-PRIVATE"}',
      conflictStrategy: 'skip_existing',
    });
  expect(bad.statusCode).toBe(400);
  expect(bad.body).not.toContain('SYNTHETIC-PRIVATE');
  const response = await f.post('/api/setup/import/preview', {
      source: JSON.stringify(f.bundle),
      conflictStrategy: 'skip_existing',
    }),
    p = ImportSetupPreviewSchema.parse(response.json()),
    other = await f.session(),
    request = {
      previewId: p.id,
      expectedRevision: p.expectedRevision,
      conflictStrategy: p.conflictStrategy,
      credentials: {},
    };
  expect(
    (await f.post('/api/setup/import/apply', request, other)).statusCode,
  ).toBe(404);
  await f.post('/api/session/logout', {});
  expect(
    (await f.post('/api/setup/import/apply', request, await f.session()))
      .statusCode,
  ).toBe(404);
  expect(f.vault.values.size).toBe(0);
  expect(JSON.stringify(await f.safety.read())).not.toContain(
    'SYNTHETIC-PRIVATE',
  );
});
