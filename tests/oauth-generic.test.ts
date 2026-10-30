import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createCapabilityRuntime,
  createBindingResolver,
  createAgentBridge,
  definitionHash,
} from '@waleed/hub-core';
import { discoverOAuth } from '../packages/hub-core/src/auth/oauth-discovery.js';
import {
  beginOAuth,
  refreshOAuth,
  revokeOAuth,
  validateRecipe,
  type TokenBundle,
} from '../packages/hub-core/src/auth/oauth-flow.js';
import { createOAuthTokenManager } from '../packages/hub-core/src/auth/oauth-tokens.js';
import { createRemoteCredentials } from '../packages/hub-core/src/auth/remote-credentials.js';
import { safeMcpHttpTransport } from '../packages/hub-core/src/adapters/mcp/http.js';
import { hashData } from '../packages/hub-core/src/runtime/registry.js';
import { oauthFixture } from './helpers/oauth.js';
import { memorySecrets } from './helpers/secrets.js';
import { memoryStore } from './helpers/memory-store.js';
import { profileState } from './helpers/runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function peerFixture() {
  const peer = await oauthFixture();
  cleanups.push(peer.close);
  return peer;
}
async function grant(recipe: Parameters<typeof beginOAuth>[0]) {
  const controller = new AbortController();
  const flow = await beginOAuth(recipe, controller.signal);
  try {
    const response = await fetch(flow.authorizationUrl, { redirect: 'manual' });
    const pending = flow.finish();
    await fetch(response.headers.get('location')!);
    return await pending;
  } finally {
    flow.close();
    controller.abort();
  }
}
it('discovers RFC 9728 resource metadata and RFC 8414 authority, then binds S256 exchange to that resource', async () => {
  const peer = await peerFixture();
  const { recipe, discoveryHash } = await discoverOAuth(
    peer.recipe.endpoint,
    AbortSignal.timeout(5000),
    { fixtureOrigin: peer.recipe.fixtureOrigin! },
  );
  expect(recipe).toMatchObject({
    discovered: true,
    issuer: peer.recipe.issuer,
    resource: peer.recipe.endpoint,
    scopes: ['read'],
    revocation: `${peer.recipe.issuer}/revoke`,
  });
  expect(discoveryHash).toBe(hashData(recipe));
  const bytes = await grant(recipe);
  try {
    expect(JSON.parse(bytes.toString())).toMatchObject({
      accessToken: peer.token,
      recipe: { resource: peer.recipe.endpoint },
    });
  } finally {
    bytes.fill(0);
  }
  expect(peer.report().resources).toEqual([peer.recipe.endpoint]);
});
it.each([
  'no_pkce',
  'no_registration',
  'bad_metadata',
  'wrong_resource',
  'no_resource_metadata',
  'resource_redirect',
])('fails closed on %s before DCR or token requests', async (mode) => {
  const peer = await peerFixture();
  peer.setMode(mode);
  await expect(
    discoverOAuth(peer.recipe.endpoint, AbortSignal.timeout(5000), {
      fixtureOrigin: peer.recipe.fixtureOrigin!,
    }),
  ).rejects.toBeDefined();
  expect(peer.report().registrations).toBe(0);
  expect(peer.report().tokenRequests).toBe(0);
});
it.each([false, true])(
  'discovers a path-specific issuer with root protected-resource fallback (OIDC=%s)',
  async (oidcOnly) => {
    const peer = await oauthFixture({
      issuerPath: '/tenant',
      rootResourceOnly: true,
      oidcOnly,
    });
    cleanups.push(peer.close);
    const { recipe } = await discoverOAuth(
      peer.recipe.endpoint,
      AbortSignal.timeout(5000),
      { fixtureOrigin: peer.recipe.fixtureOrigin! },
    );
    expect(recipe.issuer).toBe(`${peer.recipe.fixtureOrigin}/tenant`);
    expect(recipe.metadata).toBe(
      `${peer.recipe.fixtureOrigin}/.well-known/${oidcOnly ? 'openid-configuration' : 'oauth-authorization-server'}/tenant`,
    );
    const bytes = await grant(recipe);
    bytes.fill(0);
  },
);
it.each([
  'http://127.0.0.1/private',
  'https://127.0.0.1/private',
  'https://169.254.169.254/latest',
  'https://user:pass@example.test/mcp',
  'https://example.test/mcp?token=private',
  'https://example.test/mcp#secret',
])('rejects credential-bearing/private discovery URLs %s', async (endpoint) => {
  await expect(
    discoverOAuth(endpoint, AbortSignal.timeout(1000)),
  ).rejects.toBeDefined();
});
it('allows metadata-authorized cross-origin endpoints while retaining strict legacy recipe origin policy', () => {
  const recipe = {
    id: 'generic',
    name: 'Remote',
    endpoint: 'https://mcp.example.test/mcp',
    resource: 'https://mcp.example.test/mcp',
    issuer: 'https://identity.example.test',
    metadata:
      'https://identity.example.test/.well-known/oauth-authorization-server',
    authorize: 'https://login.example.test/authorize',
    token: 'https://tokens.example.test/token',
    register: 'https://identity.example.test/register',
    scopes: ['read'],
  };
  expect(() => validateRecipe({ ...recipe, discovered: true })).not.toThrow();
  expect(() => validateRecipe(recipe)).toThrow();
});
it('accepts an absent iss only when discovery says it is not supported; still binds the callback to state', async () => {
  const peer = await peerFixture();
  peer.setMode('no_iss');
  const { recipe } = await discoverOAuth(
    peer.recipe.endpoint,
    AbortSignal.timeout(5000),
    { fixtureOrigin: peer.recipe.fixtureOrigin! },
  );
  expect(recipe.responseIssuerRequired).toBe(false);
  const bytes = await grant(recipe);
  bytes.fill(0);
  expect(peer.report().tokenRequests).toBe(1);
});
it('uses a configured Client ID metadata document when supported, without DCR', async () => {
  const peer = await peerFixture();
  peer.setMode('metadata_document');
  const { recipe } = await discoverOAuth(
    peer.recipe.endpoint,
    AbortSignal.timeout(5000),
    {
      fixtureOrigin: peer.recipe.fixtureOrigin!,
      clientMetadataUrl: `${peer.recipe.issuer}/client.json`,
    },
  );
  const bytes = await grant(recipe);
  bytes.fill(0);
  expect(peer.report()).toMatchObject({ registrations: 0, tokenRequests: 1 });
});
it('preserves a refresh token when omitted and handles real rotation plus RFC 7009 empty success responses', async () => {
  const peer = await peerFixture();
  const { recipe } = await discoverOAuth(
    peer.recipe.endpoint,
    AbortSignal.timeout(5000),
    { fixtureOrigin: peer.recipe.fixtureOrigin! },
  );
  const original = await grant(recipe);
  peer.setMode('omit_refresh');
  const retained = await refreshOAuth(
    recipe,
    original,
    AbortSignal.timeout(5000),
  );
  try {
    expect((JSON.parse(retained.toString()) as TokenBundle).refreshToken).toBe(
      peer.refresh,
    );
  } finally {
    retained.fill(0);
  }
  peer.setMode('rotation');
  const rotated = await refreshOAuth(
    recipe,
    original,
    AbortSignal.timeout(5000),
  );
  original.fill(0);
  try {
    expect(JSON.parse(rotated.toString())).toMatchObject({
      accessToken: `${peer.token}_1`,
      refreshToken: `${peer.refresh}_1`,
    });
    expect(await revokeOAuth(recipe, rotated, AbortSignal.timeout(5000))).toBe(
      true,
    );
    expect(peer.report().revoked).toEqual([
      `${peer.refresh}_1`,
      `${peer.token}_1`,
    ]);
  } finally {
    rotated.fill(0);
  }
});

async function accountFixture() {
  const peer = await peerFixture(),
    secrets = memorySecrets();
  cleanups.push(async () => secrets.close());
  const { recipe } = await discoverOAuth(
    peer.recipe.endpoint,
    AbortSignal.timeout(5000),
    { fixtureOrigin: peer.recipe.fixtureOrigin! },
  );
  const bytes = await grant(recipe),
    bundle = JSON.parse(bytes.toString()) as TokenBundle;
  bytes.fill(0);
  const state = profileState(['remote']),
    connector = state.connectors[0]!;
  if (connector.executionMode !== 'remote') throw new Error();
  connector.endpoint = peer.recipe.endpoint;
  const id = `wmh-secret-${crypto.randomUUID()}`;
  connector.headerBindings.Authorization = id;
  connector.credentialFormats = { Authorization: 'bearer' };
  connector.trustApproval!.definitionHash = definitionHash(connector);
  state.secretReferences = [
    {
      id,
      adapter: 'windows',
      kind: 'oauth',
      recipeId: 'generic',
      present: true,
      ownerIds: [connector.id],
    },
  ];
  const value = Buffer.from(JSON.stringify(bundle));
  await secrets.backend.put(id, value, AbortSignal.timeout(1000));
  value.fill(0);
  const store = memoryStore(state);
  const expire = async () => {
    const value = await secrets.backend.read!(id, AbortSignal.timeout(1000));
    const bundle = JSON.parse(value.toString()) as TokenBundle;
    value.fill(0);
    bundle.expiresAt = Date.now() - 1;
    const bytes = Buffer.from(JSON.stringify(bundle));
    await secrets.backend.replace!(id, bytes, AbortSignal.timeout(1000));
    bytes.fill(0);
  };
  return { peer, secrets, store, connector, id, expire };
}
it('serializes competing refreshes, persists the rotated bundle once, and clears every leased buffer', async () => {
  const f = await accountFixture();
  await f.expire();
  f.peer.setMode('rotation');
  const ensure1 = createOAuthTokenManager({ windows: f.secrets.backend }, () =>
    f.store.read(),
  );
  const ensure2 = createOAuthTokenManager({ windows: f.secrets.backend }, () =>
    f.store.read(),
  );
  await Promise.all([
    ensure1(f.connector, AbortSignal.timeout(5000)),
    ensure2(f.connector, AbortSignal.timeout(5000)),
  ]);
  expect(f.peer.report().refreshRequests).toBe(1);
  expect(JSON.parse(f.secrets.values.get(f.id)!.toString())).toMatchObject({
    accessToken: `${f.peer.token}_1`,
    refreshToken: `${f.peer.refresh}_1`,
  });
  expect(
    f.secrets.reads.every((bytes) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
  expect(
    f.secrets.writes.every((bytes) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
  expect(JSON.stringify(await f.store.read())).not.toContain(f.peer.token);
});
it('does not overwrite a good encrypted bundle after failed refresh, lost approval, or cancellation', async () => {
  const f = await accountFixture();
  await f.expire();
  f.peer.setMode('refresh_failure');
  const original = Buffer.from(f.secrets.values.get(f.id)!);
  const ensure = createOAuthTokenManager({ windows: f.secrets.backend }, () =>
    f.store.read(),
  );
  await expect(
    ensure(f.connector, AbortSignal.timeout(5000)),
  ).rejects.toHaveProperty('reason', 'refresh_failed');
  expect(f.secrets.values.get(f.id)!.equals(original)).toBe(true);
  original.fill(0);
  const state = await f.store.read();
  state.connectors[0]!.enabled = false;
  await f.store.write(state.revision, {
    ...state,
    revision: state.revision + 1,
  });
  await expect(
    ensure(f.connector, AbortSignal.timeout(5000)),
  ).rejects.toHaveProperty('reason', 'definition_changed');
  expect(
    f.secrets.reads.every((bytes) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
});
it.each(['streamable_http', 'sse'] as const)(
  'injects rotated tokens into %s tool calls while reusing the persistent MCP peer',
  async (transport) => {
    const f = await accountFixture();
    let starts = 0;
    const bridge = createAgentBridge(
      () => f.store.read(),
      async (connector, signal) => {
        if (connector.executionMode !== 'remote') throw new Error();
        starts++;
        const credentials = createRemoteCredentials(
          { windows: f.secrets.backend },
          () => f.store.read(),
          connector,
          signal,
        );
        const client = new Client(
          { name: 'oauth-test-upstream', version: '1' },
          { capabilities: {} },
        );
        const remote = safeMcpHttpTransport(
          connector.endpoint,
          transport,
          signal,
          f.peer.recipe.fixtureOrigin,
          credentials.headers,
        );
        await client.connect(remote);
        return {
          client,
          assertPublic() {},
          async dispose() {
            try {
              await client.close();
            } finally {
              await credentials.dispose();
            }
          },
        };
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    const agent = new Client(
      { name: 'oauth-test-agent', version: '1' },
      { capabilities: {} },
    );
    await agent.connect(b);
    try {
      const list = await agent.listTools();
      expect(list.tools).toHaveLength(1);
      await f.expire();
      f.peer.setMode('rotation');
      for (let i = 0; i < 2; i++)
        expect(
          await agent.callTool({ name: list.tools[0]!.name, arguments: {} }),
        ).toMatchObject({ content: [{ text: 'Synthetic authorized result' }] });
      expect(starts).toBe(1);
      expect(f.peer.report().refreshRequests).toBe(1);
      expect(f.peer.report().bearerHeaders.slice(-2)).toEqual([
        `Bearer ${f.peer.token}_1`,
        `Bearer ${f.peer.token}_1`,
      ]);
    } finally {
      await agent.close();
      await bridge.close();
    }
    expect(
      f.secrets.reads.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);
  },
  15_000,
);

async function serviceFixture() {
  const peer = await peerFixture(),
    secrets = memorySecrets(),
    store = memoryStore(profileState(['remote']));
  const runtime = createCapabilityRuntime({
    workingDirectory: 'unused',
    fixtureOrigin: peer.recipe.fixtureOrigin!,
    resolveBindings: createBindingResolver({ windows: secrets.backend }, () =>
      store.read(),
    ),
  });
  const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
    secrets: { windows: secrets.backend },
    oauthRecipes: [],
    oauthDiscovery: async (_endpoint, signal) => {
      const { recipe } = await discoverOAuth(peer.recipe.endpoint, signal, {
        fixtureOrigin: peer.recipe.fixtureOrigin!,
      });
      recipe.endpoint = 'https://example.test/mcp';
      return { recipe, discoveryHash: hashData(recipe) };
    },
    runtime: {
      discover: (connector, signal) =>
        runtime.discover(
          {
            ...connector,
            executionMode: 'remote',
            endpoint: peer.recipe.endpoint,
            transport: 'streamable_http',
          },
          signal,
        ),
    },
  });
  cleanups.push(async () => {
    await hub.close();
    secrets.close();
  });
  const connector = (await store.read()).connectors[0]!;
  const discoveryInput = {
    expectedRevision: 0,
    expectedConnectorRevision: 1,
    definitionHash: definitionHash(connector),
    approveDiscovery: true,
  };
  const discovered = await hub.auth.discover(
    connector.id,
    discoveryInput,
    'owner',
  );
  const input = {
    expectedRevision: 0,
    expectedConnectorRevision: 1,
    definitionHash: discoveryInput.definitionHash,
    approveSignInAndDiscovery: true,
    recipeId: 'generic',
    discoveryHash: discovered.discoveryHash,
    scopes: ['read'],
  };
  return { peer, secrets, store, hub, input, discoveryInput, discovered };
}
async function signIn(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const job = await f.hub.auth.start('connector-0', f.input, 'owner');
  for (let i = 0; i < 300; i++) {
    const state = f.hub.auth.job(job.id, 'owner');
    if (state.authorizationUrl) {
      const response = await fetch(state.authorizationUrl, {
        redirect: 'manual',
      });
      await fetch(response.headers.get('location')!);
      break;
    }
    if (state.completedAt) throw new Error(`OAuth failed: ${state.reason}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await f.hub.auth.drain();
  expect(f.hub.auth.job(job.id, 'owner').state).toBe('succeeded');
}
it('requires owner-scoped discovery and exact consent, lists accounts without tokens, and revokes/disconnects locally', async () => {
  const f = await serviceFixture();
  await expect(
    f.hub.auth.start('connector-0', f.input, 'another-owner'),
  ).rejects.toHaveProperty('code', 'invalid');
  await expect(
    f.hub.auth.start('connector-0', { ...f.input, scopes: ['write'] }, 'owner'),
  ).rejects.toHaveProperty('code', 'invalid');
  await signIn(f);
  const accounts = await f.hub.auth.accounts();
  expect(accounts.accounts).toHaveLength(1);
  expect(accounts.accounts[0]).toMatchObject({
    connectorId: 'connector-0',
    scopes: ['read'],
    refreshSupported: true,
    revocationSupported: true,
  });
  expect(JSON.stringify([accounts, await f.hub.inventory()])).not.toContain(
    f.peer.token,
  );
  const state = await f.store.read(),
    connector = state.connectors[0]!;
  expect(
    await f.hub.auth.disconnect(connector.id, {
      expectedRevision: state.revision,
      expectedConnectorRevision: connector.revision,
      confirmDisconnect: true,
      revokeProvider: true,
    }),
  ).toMatchObject({
    disconnected: true,
    providerRevoked: true,
    providerActionRequired: false,
  });
  expect(f.peer.report().revoked).toEqual([f.peer.refresh, f.peer.token]);
  expect((await f.hub.auth.accounts()).accounts).toEqual([]);
  expect(f.secrets.values.size).toBe(0);
  expect((await f.store.read()).connectors[0]!.trustApproval).toBe(null);
  expect(
    f.secrets.reads.every((bytes) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
});
it('does not claim revocation or delete the local account when the provider rejects revocation', async () => {
  const f = await serviceFixture();
  await signIn(f);
  f.peer.setMode('revocation_failure');
  const state = await f.store.read(),
    connector = state.connectors[0]!;
  await expect(
    f.hub.auth.disconnect(connector.id, {
      expectedRevision: state.revision,
      expectedConnectorRevision: connector.revision,
      confirmDisconnect: true,
      revokeProvider: true,
    }),
  ).rejects.toBeDefined();
  expect((await f.hub.auth.accounts()).accounts).toHaveLength(1);
  expect(
    await f.hub.auth.disconnect(connector.id, {
      expectedRevision: state.revision,
      expectedConnectorRevision: connector.revision,
      confirmDisconnect: true,
      revokeProvider: false,
    }),
  ).toMatchObject({
    disconnected: true,
    providerRevoked: false,
    providerActionRequired: true,
  });
});
it('rejects authority drift between discovery consent and the actual sign-in', async () => {
  const f = await serviceFixture();
  f.peer.setMode('no_iss');
  const job = await f.hub.auth.start('connector-0', f.input, 'owner');
  await f.hub.auth.drain();
  expect(f.hub.auth.job(job.id, 'owner')).toMatchObject({
    state: 'failed',
    reason: 'definition_changed',
  });
  expect(f.peer.report().registrations).toBe(0);
  expect(f.secrets.values.size).toBe(0);
});
