import { it, expect } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
  addManualMcp,
} from '@waleed/hub-core';
import { memoryStore } from '../helpers/memory-store.js';
import { memorySecrets } from '../helpers/secrets.js';
it('protects scan/integrate/disconnect/manual routes and returns value-free partial/complete receipts', async () => {
  let config: string | null =
    '{"plugins":["keep"],"private":"SYNTHETIC-existing-private"}';
  const secrets = memorySecrets();
  const lifecycle = createLifecycle(
    memoryStore(),
    Date.now,
    createMemorySafetyLedger(),
    {
      secrets: { windows: secrets.backend },
      integrations: {
        targets: [
          {
            id: 'cursor',
            name: 'Cursor',
            paths: ['C:\\Synthetic\\mcp.json'],
            format: 'mcpServers',
            aliases: ['cursor'],
            reconnect: 'Reconnect explicitly.',
          },
        ],
        node: 'C:\\Node24\\node.exe',
        registry: 'C:\\Runtime\\state.json',
        bridge: 'C:\\Hub\\bridge.js',
        files: {
          async read() {
            return config;
          },
          async replace(_path, before, after) {
            expect(config).toBe(before);
            config = after;
          },
          async backup() {
            return 'timestamp.bak';
          },
        },
        discovery: {
          async find() {
            return ['C:\\Synthetic\\Cursor.exe'];
          },
          async read() {
            return { status: 'missing' };
          },
          async run() {
            throw new Error('No agent may be started by config integration.');
          },
        },
      },
    },
  );
  const server = await createHubServer({ port: 4177, lifecycle });
  const host = '127.0.0.1:4177',
    origin = `http://${host}`;
  try {
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/agents/scan',
          headers: { host, origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const session = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token: server.issueLaunchToken() },
    });
    const headers = {
      host,
      origin,
      cookie: String(session.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
    };
    const scan = await server.app.inject({
      method: 'POST',
      url: '/api/agents/scan',
      headers,
      payload: {},
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.body).not.toContain('SYNTHETIC-existing-private');
    const agent = scan.json<{ agents: Array<{ fingerprint: string }> }>()
      .agents[0]!;
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/agents/cursor/integrate',
          headers: { host, origin, cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const integrated = await server.app.inject({
      method: 'POST',
      url: '/api/agents/cursor/integrate',
      headers,
      payload: {
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      },
    });
    expect(integrated.statusCode).toBe(200);
    expect(integrated.json()).toMatchObject({
      agent: { status: 'integrated' },
    });
    const manual = await server.app.inject({
      method: 'POST',
      url: '/api/connectors/manual',
      headers,
      payload: {
        expectedRevision: 1,
        name: 'Manual synthetic remote',
        type: 'streamable_http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'SYNTHETIC-manual-private-value' },
        autoSync: true,
        confirmSave: true,
      },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({
      state: 'saved',
      requiresApproval: true,
      authenticationVerified: false,
      sync: { agents: [{ status: 'synced' }] },
    });
    expect(manual.body).not.toContain('SYNTHETIC-manual-private-value');
    const inventory = await lifecycle.inventory();
    expect(JSON.stringify(inventory)).not.toContain(
      'SYNTHETIC-manual-private-value',
    );
    expect(config).not.toContain('SYNTHETIC-manual-private-value');
    expect(
      secrets.writes.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);
    const status = await server.app.inject({
      url: '/api/agents/cursor/status',
      headers,
    });
    const current = status.json<{ fingerprint: string }>();
    const disconnected = await server.app.inject({
      method: 'POST',
      url: '/api/agents/cursor/disconnect',
      headers,
      payload: {
        expectedRevision: inventory.revision,
        fingerprint: current.fingerprint,
        confirmConfigurationChange: true,
      },
    });
    expect(disconnected.statusCode).toBe(200);
    expect(config).toContain('"plugins"');
    expect(config).not.toContain('waleed-mcp-hub');
  } finally {
    await server.app.close();
    secrets.close();
  }
});
it('returns a partial-save ID if protected storage fails and clears transient inputs', async () => {
  const hub = createLifecycle(memoryStore());
  const input = {
    expectedRevision: 0,
    name: 'Partial remote',
    type: 'streamable_http',
    url: 'https://example.test/mcp',
    headers: { Authorization: 'SYNTHETIC_PARTIAL_PRIVATE' },
    confirmSave: true,
  };
  try {
    const result = await addManualMcp(hub, input, 'owner');
    expect(result.state).toBe('partially_saved');
    expect((await hub.inventory()).connectors.map((item) => item.id)).toEqual([
      result.connectorId,
    ]);
    expect(input.headers.Authorization).toBe('');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PARTIAL_PRIVATE');
  } finally {
    await hub.close();
  }
});
it('rejects credential echoes before any registry effect, including escaped text', async () => {
  const hub = createLifecycle(memoryStore());
  const secret = 'SYNTHETIC_"manual\\private';
  const input = {
    expectedRevision: 0,
    name: secret,
    type: 'streamable_http',
    url: 'https://example.test/mcp',
    headers: { Authorization: secret },
    confirmSave: true,
  };
  try {
    await expect(addManualMcp(hub, input, 'owner')).rejects.toMatchObject({
      code: 'invalid',
    });
    expect((await hub.inventory()).connectors).toEqual([]);
    expect(input.headers.Authorization).toBe('');
  } finally {
    await hub.close();
  }
});
