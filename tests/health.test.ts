import { afterEach, expect, it, vi } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  inspectOAuthHealth,
  definitionHash,
} from '@waleed/hub-core';
import { RuntimeFault } from '../packages/hub-core/src/runtime/capabilities.js';
import {
  AuthFault,
  type OAuthRecipe,
} from '../packages/hub-core/src/auth/oauth-flow.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';
import { profileState } from './helpers/runtime.js';
import { healthFixture } from './helpers/health.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('evaluates expired OAuth and revoked connectivity, with no retained or reflected token data', async () => {
  const f = await healthFixture();
  cleanup.push(() => f.close());
  expect(
    (await f.hub.health.snapshot()).connectors.map((item) => item.status),
  ).toEqual(['untested', 'needs_reauth', 'untested']);
  await f.hub.health.retest();
  await f.hub.health.drain();
  const result = await f.hub.health.snapshot();
  expect(result.connectors.map((item) => item.status)).toEqual([
    'healthy',
    'needs_reauth',
    'needs_reauth',
  ]);
  expect(result.connectors[1]!.reason).toBe('oauth_expired');
  expect(result.connectors[2]!.reason).toBe('auth_required');
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-HEALTH');
  expect(
    f.secrets.reads.every((bytes) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
  expect(f.peer.methods).not.toContain('tools/call');
  expect(f.peer.methods).not.toContain('resources/read');
  expect(f.peer.methods).not.toContain('prompts/get');
});
it.each([
  null,
  {},
  { accessToken: '', expiresAt: 1, refreshToken: null },
  { accessToken: 'private', expiresAt: 'tomorrow', refreshToken: null },
  { accessToken: 'private', expiresAt: -1, refreshToken: null },
])('rejects invalid OAuth bundles without echoing their content %j', (raw) => {
  expect(inspectOAuthHealth(raw)).toMatchObject({
    invalid: true,
    expiresAt: null,
  });
  expect(JSON.stringify(inspectOAuthHealth(raw))).not.toContain('private');
});
it('recognizes non-expiring and refreshable valid OAuth metadata without retaining token strings', () => {
  expect(
    inspectOAuthHealth({
      accessToken: 'private',
      refreshToken: 'private-refresh',
      expiresAt: null,
    }),
  ).toEqual({ invalid: false, unavailable: false, expiresAt: null });
});
it('does not auto-start anything by default; opt-in ticking performs bounded discovery without installation', async () => {
  const state = profileState(['native']),
    store = memoryStore(state),
    calls: unknown[] = [],
    hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      runtime: {
        async discover(_connector, _signal, options) {
          calls.push(options);
          return {
            protocolVersion: 'synthetic',
            tools: [],
            resourceCount: 0,
            promptCount: 0,
          };
        },
      },
    });
  cleanup.push(() => hub.close());
  await hub.health.tick();
  await hub.health.drain();
  expect(calls).toEqual([]);
  await hub.settings.update({
    expectedRevision: 0,
    backgroundHealthChecks: true,
    keepRunningInTray: true,
  });
  await hub.health.tick();
  await hub.health.drain();
  expect(calls).toEqual([{ allowInstall: false }]);
  expect((await hub.health.snapshot()).connectors[0]!.status).toBe('healthy');
});
it('skips disabled/unapproved connectors, degrades network failures and honors invalidation', async () => {
  const state = profileState(['native', 'native', 'native']);
  state.connectors[0]!.enabled = false;
  state.connectors[1]!.trustApproval = null;
  const store = memoryStore(state),
    calls: string[] = [],
    hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      runtime: {
        async discover(connector) {
          calls.push(connector.id);
          throw new RuntimeFault('protocol_error');
        },
      },
    });
  cleanup.push(() => hub.close());
  await hub.health.retest();
  await hub.health.drain();
  expect(calls).toEqual(['connector-2']);
  expect(
    (await hub.health.snapshot()).connectors.map((item) => item.status),
  ).toEqual(['untested', 'untested', 'degraded']);
});
it('tracks failed refresh as Needs Re-auth even before a still-valid access token expires', async () => {
  const state = profileState(['remote']),
    connector = state.connectors[0]!,
    secrets = memorySecrets(),
    id = 'wmh-secret-11111111-1111-4111-8111-111111111111';
  connector.headerBindings = { Authorization: id };
  connector.credentialFormats = { Authorization: 'bearer' };
  state.secretReferences = [
    {
      id,
      adapter: 'windows',
      kind: 'oauth',
      recipeId: 'synthetic',
      present: true,
      ownerIds: [connector.id],
    },
  ];
  connector.trustApproval!.definitionHash = definitionHash(connector);
  secrets.values.set(
    id,
    Buffer.from(
      JSON.stringify({
        accessToken: 'SYNTHETIC-PRIVATE',
        refreshToken: 'SYNTHETIC-REFRESH',
        expiresAt: Date.now() + 3600000,
        clientId: 'synthetic',
      }),
    ),
  );
  const recipe: OAuthRecipe = {
    id: 'synthetic',
    name: 'Synthetic',
    endpoint: 'https://example.test/mcp',
    issuer: 'https://example.test',
    metadata: 'https://example.test/metadata',
    authorize: 'https://example.test/authorize',
    token: 'https://example.test/token',
    register: 'https://example.test/register',
    resource: 'https://example.test/mcp',
    scopes: ['read'],
  };
  const hub = createLifecycle(
    memoryStore(state),
    Date.now,
    createMemorySafetyLedger(),
    {
      secrets: { windows: secrets.backend },
      oauthRecipes: [recipe],
      oauthFlows: {
        async begin() {
          throw new Error('Not used');
        },
        async refresh() {
          throw new AuthFault('refresh_failed');
        },
      },
    },
  );
  cleanup.push(async () => {
    await hub.close();
    secrets.close();
  });
  await hub.auth.start(
    connector.id,
    {
      expectedRevision: 0,
      expectedConnectorRevision: 1,
      definitionHash: definitionHash(connector),
      recipeId: 'synthetic',
      approveSignInAndDiscovery: true,
    },
    'owner',
    true,
  );
  await hub.auth.drain();
  expect((await hub.health.snapshot()).connectors[0]).toMatchObject({
    status: 'needs_reauth',
    reason: 'refresh_failed',
  });
});
it('cancels its owned background checks and drains cleanly on close', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
      started = resolve;
    }),
    hub = createLifecycle(
      memoryStore(profileState(['native'])),
      Date.now,
      createMemorySafetyLedger(),
      {
        runtime: {
          async discover(_connector, signal) {
            started();
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            throw new RuntimeFault('cancelled');
          },
        },
      },
    );
  await hub.health.retest();
  await ready;
  await hub.close();
  expect((await hub.checks.observations())[0]!.state).toBe('cancelled');
});
it('marks malformed protected OAuth JSON as Needs Re-auth and zeroes the read buffer', async () => {
  const f = await healthFixture();
  cleanup.push(() => f.close());
  const state = await f.store.read(),
    id = state.connectors[1]!.headerBindings.Authorization!;
  f.secrets.values.get(id)!.fill(0);
  f.secrets.values.set(id, Buffer.from('SYNTHETIC-INVALID-OAUTH-JSON'));
  const response = await f.hub.health.snapshot();
  expect(response.connectors[1]).toMatchObject({
    status: 'needs_reauth',
    reason: 'invalid_oauth',
  });
  expect(JSON.stringify(response)).not.toContain('SYNTHETIC-INVALID');
  expect(
    f.secrets.reads.every((bytes) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
});
it('runs the opt-in five-minute timer and stops scheduling after shutdown', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const hub = createLifecycle(
    memoryStore(profileState(['native'])),
    Date.now,
    createMemorySafetyLedger(),
    {
      runtime: {
        async discover() {
          calls++;
          return {
            protocolVersion: 'synthetic',
            tools: [],
            resourceCount: 0,
            promptCount: 0,
          };
        },
      },
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(300000);
    expect(calls).toBe(0);
    await hub.settings.update({
      expectedRevision: 0,
      backgroundHealthChecks: true,
      keepRunningInTray: true,
    });
    await vi.advanceTimersByTimeAsync(300000);
    await hub.health.drain();
    expect(calls).toBe(1);
    await hub.close();
    await vi.advanceTimersByTimeAsync(300000);
    expect(calls).toBe(1);
  } finally {
    await hub.close();
    vi.useRealTimers();
  }
});
