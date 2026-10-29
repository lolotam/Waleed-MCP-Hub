import { afterEach, describe, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
  definitionHash,
  RuntimeFault,
} from '@waleed/hub-core';
import type { ImportPreview, OperationPreview, Job } from '@waleed/contracts';
import { memoryStore } from '../helpers/memory-store.js';
import { definition } from '../helpers/runtime.js';
import { managedFixture } from '../helpers/materialization.js';

const hubs: Awaited<ReturnType<typeof createHubServer>>[] = [];
const host = '127.0.0.1:4177',
  origin = `http://${host}`;
async function setup() {
  const fixture = managedFixture();
  const lifecycle = createLifecycle(
    memoryStore(),
    Date.now,
    createMemorySafetyLedger(),
    {
      materializer: fixture.materializer,
      runtime: {
        async discover(connector) {
          if (connector.id === 'auth') throw new RuntimeFault('auth_required');
          return {
            protocolVersion: '2025-11-25',
            tools: [{ name: 'fixture', role: 'upstream' }],
            resourceCount: 0,
            promptCount: 0,
          };
        },
      },
    },
  );
  const hub = await createHubServer({ port: 4177, lifecycle });
  hubs.push(hub);
  return { hub, lifecycle, fixture };
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
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.app.close();
});

describe('P5 protected lifecycle HTTP interface', () => {
  it('saves no-secret imports through a separate registry preview and never executes on save/materialize', async () => {
    const { hub, lifecycle, fixture } = await setup();
    const headers = await login(hub);
    const draft = (
      await hub.app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        headers,
        payload: {
          source: JSON.stringify({
            id: 'remote',
            name: 'Synthetic remote',
            url: 'https://example.test/mcp',
          }),
          expectedRevision: 0,
        },
      })
    ).json<ImportPreview>();
    const previewResponse = await hub.app.inject({
      method: 'POST',
      url: `/api/imports/${draft.id}/save-preview`,
      headers,
      payload: { expectedRevision: 0 },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json<OperationPreview>();
    expect((await lifecycle.inventory()).connectors).toEqual([]);
    expect(
      (await hub.app.inject({ url: `/api/imports/${draft.id}`, headers }))
        .statusCode,
    ).toBe(404);
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/operations/apply',
      headers,
      payload: { previewId: preview.id },
    });
    expect(response.statusCode).toBe(202);
    await lifecycle.drain();
    expect(
      (
        await hub.app.inject({
          url: `/api/jobs/${response.json<Job>().id}`,
          headers,
        })
      ).json(),
    ).toMatchObject({ state: 'succeeded' });
    expect(fixture.disk.size).toBe(0);
  });
  it('requires session/Origin/CSRF, blocks free-form execution input and scopes runtime jobs to their owner', async () => {
    const { hub, lifecycle } = await setup();
    const headers = await login(hub);
    const operation = await lifecycle.preview(
      {
        kind: 'create_connector',
        expectedRevision: 0,
        definition: definition({
          id: 'remote',
          url: 'https://example.test/mcp',
        }),
      },
      'owner',
    );
    await lifecycle.apply(operation.id, 'owner');
    await lifecycle.drain();
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/connectors/remote/check',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    const connector = (await lifecycle.inventory()).connectors[0]!;
    const approval = await lifecycle.preview(
      {
        kind: 'approve_connector',
        connectorId: connector.id,
        expectedRevision: 1,
        expectedConnectorRevision: 1,
        definitionHash: definitionHash(connector),
        approveExecution: true,
      },
      'owner',
    );
    await lifecycle.apply(approval.id, 'owner');
    await lifecycle.drain();
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/connectors/remote/check',
          headers: { host, origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/connectors/remote/check',
          headers: { host, origin, cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/connectors/remote/check',
          headers,
          payload: { executable: 'untrusted.exe' },
        })
      ).statusCode,
    ).toBe(400);
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/connectors/remote/check',
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    const job = response.json<{ id: string }>();
    await lifecycle.checks.drain();
    expect(
      (
        await hub.app.inject({ url: `/api/runtime/jobs/${job.id}`, headers })
      ).json(),
    ).toMatchObject({ state: 'succeeded' });
    const other = await login(hub);
    expect(
      (
        await hub.app.inject({
          url: `/api/runtime/jobs/${job.id}`,
          headers: other,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: `/api/runtime/jobs/${job.id}/cancel`,
          headers: other,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await hub.app.inject({ url: '/api/connectors', headers })).json(),
    ).toMatchObject({
      observations: [{ state: 'connected', method: 'mcp_discovery' }],
    });
  });
  it('cannot persist private import credentials through the save-preview bridge', async () => {
    const { hub, lifecycle, fixture } = await setup();
    const headers = await login(hub);
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/imports/preview',
      headers,
      payload: {
        source: JSON.stringify({
          command: 'tool',
          env: { TOKEN: 'SYNTHETIC-PRIVATE-ONLY' },
        }),
        expectedRevision: 0,
      },
    });
    const draft = response.json<ImportPreview>();
    expect(
      (
        await hub.app.inject({
          method: 'POST',
          url: `/api/imports/${draft.id}/save-preview`,
          headers,
          payload: { expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(503);
    expect((await lifecycle.inventory()).revision).toBe(0);
    expect(fixture.disk.size).toBe(0);
  });
});
