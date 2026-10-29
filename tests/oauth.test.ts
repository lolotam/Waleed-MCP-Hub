import { afterEach, describe, expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createCapabilityRuntime,
  createBindingResolver,
  definitionHash,
} from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';
import { profileState } from './helpers/runtime.js';
import { memorySecrets } from './helpers/secrets.js';
import { oauthFixture } from './helpers/oauth.js';
import {
  beginOAuth,
  refreshOAuth,
  validateRecipe,
} from '../packages/hub-core/src/auth/oauth-flow.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup(timeoutMs = 5000) {
  const peer = await oauthFixture();
  const state = profileState(['remote']);
  const store = memoryStore(state);
  const secrets = memorySecrets();
  const runtime = createCapabilityRuntime({
    workingDirectory: 'unused-http-only',
    fixtureOrigin: peer.recipe.fixtureOrigin!,
    resolveBindings: createBindingResolver({ windows: secrets.backend }, () =>
      store.read(),
    ),
  });
  const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
    secrets: { windows: secrets.backend },
    oauthRecipes: [{ ...peer.recipe, endpoint: 'https://example.test/mcp' }],
    oauthFlows: {
      begin: (_recipe, signal, now) => beginOAuth(peer.recipe, signal, now),
      refresh: (_recipe, previous, signal, now) =>
        refreshOAuth(peer.recipe, previous, signal, now),
    },
    oauthTimeoutMs: timeoutMs,
    runtime: {
      discover: (connector, signal) =>
        runtime.discover(
          {
            ...connector,
            executionMode: 'remote',
            transport: 'streamable_http',
            endpoint: peer.recipe.endpoint,
          },
          signal,
        ),
    },
  });
  // The construction-only flow seam maps the synthetic registry endpoint to an
  // exact local OAuth peer. HTTP can never supply a flow adapter or recipe.
  const serviceRecipe = {
    ...peer.recipe,
    endpoint: 'https://example.test/mcp',
  };
  cleanups.push(async () => {
    await hub.close();
    await peer.close();
    secrets.close();
  });
  const input = {
    expectedRevision: 0,
    expectedConnectorRevision: 1,
    recipeId: serviceRecipe.id,
    definitionHash: definitionHash(state.connectors[0]!),
    approveSignInAndDiscovery: true,
  };
  return { peer, hub, store, secrets, input };
}
async function waitFor<T>(read: () => T, ready: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic auth job did not settle.');
}

describe('bounded OAuth PKCE and supported recipe policy', () => {
  it('fails protected-store preflight before registering or authorizing a provider', async () => {
    const { hub, input, peer, secrets } = await setup();
    secrets.backend.has = async () => {
      throw new Error('SYNTHETIC-protection-unavailable');
    };
    const job = await hub.auth.start('connector-0', input, 'owner');
    await hub.auth.drain();
    expect(hub.auth.job(job.id, 'owner')).toMatchObject({
      state: 'failed',
      reason: 'dependency_unavailable',
    });
    expect(peer.report().registrations).toBe(0);
    expect(secrets.values.size).toBe(0);
  });
  it('discards a grant after the approved definition changes while waiting for consent', async () => {
    const { hub, peer, input, secrets } = await setup();
    const job = await hub.auth.start('connector-0', input, 'owner');
    const ready = await waitFor(
      () => hub.auth.job(job.id, 'owner'),
      (value) => value.state === 'awaiting_user',
    );
    const preview = await hub.preview(
      {
        kind: 'set_connector_enabled',
        expectedRevision: 0,
        connectorId: 'connector-0',
        enabled: false,
      },
      'owner',
    );
    await hub.apply(preview.id, 'owner');
    await hub.drain();
    const response = await fetch(ready.authorizationUrl!, {
      redirect: 'manual',
    });
    await fetch(response.headers.get('location')!);
    await hub.auth.drain();
    expect(hub.auth.job(job.id, 'owner')).toMatchObject({
      state: 'failed',
      reason: 'definition_changed',
    });
    expect(secrets.values.size).toBe(0);
    expect(peer.methods).toEqual([]);
  });
  it('blocks sign-in before network/registration when recovery is unresolved', async () => {
    const { hub, peer, input } = await setup();
    const timestamp = new Date().toISOString();
    await hub.safety.prepare({
      id: crypto.randomUUID(),
      operation: 'write_credential',
      targetId: 'synthetic',
      expectedRevision: 0,
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64),
      phase: 'prepared',
      reason: 'none',
      createdAt: timestamp,
      updatedAt: timestamp,
      external: true,
    });
    await expect(
      hub.auth.start('connector-0', input, 'owner'),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(peer.report().registrations).toBe(0);
  });
  it('completes sign-in, stores only protected references, discovers before success and isolates failed refresh', async () => {
    const { hub, input, peer, secrets } = await setup();
    const job = await hub.auth.start('connector-0', input, 'owner');
    const ready = await waitFor(
      () => hub.auth.job(job.id, 'owner'),
      (value) => value.state === 'awaiting_user',
    );
    const response = await fetch(ready.authorizationUrl!, {
      redirect: 'manual',
    });
    await fetch(response.headers.get('location')!);
    await hub.auth.drain();
    expect(hub.auth.job(job.id, 'owner')).toMatchObject({
      state: 'succeeded',
      authorizationUrl: null,
    });
    expect((await hub.checks.observations())[0]?.state).toBe('connected');
    expect(peer.methods).not.toContain('tools/call');
    expect(
      JSON.stringify([
        await hub.inventory(),
        hub.auth.job(job.id, 'owner'),
        await hub.auth.status('connector-0'),
      ]),
    ).not.toContain(peer.token);
    expect(
      secrets.writes.every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
    const state = await hub.inventory();
    const connector = state.connectors[0]!;
    peer.setMode('refresh_failure');
    const refresh = await hub.auth.start(
      'connector-0',
      {
        ...input,
        expectedRevision: state.revision,
        expectedConnectorRevision: connector.revision,
        definitionHash: definitionHash(connector),
      },
      'owner',
      true,
    );
    await hub.auth.drain();
    expect(hub.auth.job(refresh.id, 'owner')).toMatchObject({
      state: 'failed',
      reason: 'refresh_failed',
    });
    expect((await hub.checks.observations())[0]?.state).toBe('connected');
    expect((await hub.inventory()).revision).toBe(state.revision);
    peer.setMode('healthy');
    const retried = await hub.auth.start(
      'connector-0',
      {
        ...input,
        expectedRevision: state.revision,
        expectedConnectorRevision: connector.revision,
        definitionHash: definitionHash(connector),
      },
      'owner',
      true,
    );
    await hub.auth.drain();
    expect(hub.auth.job(retried.id, 'owner').state).toBe('succeeded');
    expect((await hub.inventory()).revision).toBe(state.revision + 1);
  });
  it('times out a pending sign-in without saving credentials or claiming connected', async () => {
    const { hub, input, secrets } = await setup(200);
    const job = await hub.auth.start('connector-0', input, 'owner');
    await hub.auth.drain();
    expect(hub.auth.job(job.id, 'owner')).toMatchObject({
      state: 'failed',
      reason: 'timed_out',
      authorizationUrl: null,
    });
    expect(secrets.values.size).toBe(0);
  });
  it('negotiates verified metadata/DCR and exchanges a state/issuer-bound callback using S256, without exposing tokens', async () => {
    const peer = await oauthFixture();
    const controller = new AbortController();
    cleanups.push(async () => {
      controller.abort();
      await peer.close();
    });
    const flow = await beginOAuth(peer.recipe, controller.signal);
    const auth = new URL(flow.authorizationUrl);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('scope')).toBe('read');
    const response = await fetch(flow.authorizationUrl, { redirect: 'manual' });
    const finish = flow.finish();
    await fetch(response.headers.get('location')!);
    const token = await finish;
    try {
      expect(JSON.parse(token.toString())).toMatchObject({
        accessToken: peer.token,
        refreshToken: peer.refresh,
      });
    } finally {
      token.fill(0);
    }
    expect(flow.authorizationUrl).not.toContain(peer.token);
    expect(peer.report().tokenRequests).toBe(1);
  });
  it.each(['bad_metadata', 'token_failure', 'over_scope', 'denied'])(
    'isolates %s with no saved credentials',
    async (mode) => {
      const peer = await oauthFixture();
      peer.setMode(mode);
      const controller = new AbortController();
      cleanups.push(async () => {
        controller.abort();
        await peer.close();
      });
      if (mode === 'bad_metadata') {
        await expect(
          beginOAuth(peer.recipe, controller.signal),
        ).rejects.toHaveProperty('reason', 'unsupported');
        return;
      }
      const flow = await beginOAuth(peer.recipe, controller.signal);
      const response = await fetch(flow.authorizationUrl, {
        redirect: 'manual',
      });
      const finish = flow.finish();
      const assertion = expect(finish).rejects.toHaveProperty(
        'reason',
        mode === 'denied' ? 'denied' : 'invalid_response',
      );
      await fetch(response.headers.get('location')!);
      await assertion;
    },
  );
  it('rejects duplicate/foreign state and issuer, consumes a callback once, and closes on cancellation', async () => {
    const peer = await oauthFixture();
    const controller = new AbortController();
    cleanups.push(async () => {
      controller.abort();
      await peer.close();
    });
    const flow = await beginOAuth(peer.recipe, controller.signal);
    const url = new URL(flow.authorizationUrl);
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('state', 'foreign');
    redirect.searchParams.set('iss', peer.recipe.issuer);
    redirect.searchParams.set('code', 'never');
    expect((await fetch(redirect)).status).toBe(400);
    const response = await fetch(flow.authorizationUrl, { redirect: 'manual' });
    const callback = new URL(response.headers.get('location')!);
    callback.searchParams.set('iss', 'https://foreign.test');
    expect((await fetch(callback)).status).toBe(400);
    const pending = flow.finish();
    const assertion = expect(pending).rejects.toHaveProperty(
      'reason',
      'cancelled',
    );
    controller.abort();
    await assertion;
    expect(peer.report().tokenRequests).toBe(0);
  });
  it('refuses arbitrary authentication origins and downgrade/credential-bearing URLs', () => {
    for (const value of [
      'http://169.254.169.254/token',
      'https://foreign.test/token',
      'https://user:pass@mcp.linear.app/token',
    ])
      expect(() =>
        validateRecipe({
          id: 'bad',
          name: 'bad',
          endpoint: 'https://mcp.linear.app/mcp',
          issuer: 'https://mcp.linear.app',
          metadata: value,
          authorize: value,
          token: value,
          register: value,
          resource: value,
          scopes: ['read'],
        }),
      ).toThrow();
  });
  it('scopes jobs, cancellation and unsupported endpoint decisions without changing connector definitions', async () => {
    const { hub, input, secrets } = await setup();
    await expect(
      hub.auth.start('connector-0', { ...input, recipeId: 'unknown' }, 'owner'),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const job = await hub.auth.start('connector-0', input, 'owner');
    expect(() => hub.auth.job(job.id, 'other')).toThrow();
    expect(() => hub.auth.cancel(job.id, 'other')).toThrow();
    hub.auth.cancel(job.id, 'owner');
    await hub.auth.drain();
    expect(hub.auth.job(job.id, 'owner').state).toBe('cancelled');
    expect(secrets.values.size).toBe(0);
    expect((await hub.inventory()).revision).toBe(0);
  });
});
