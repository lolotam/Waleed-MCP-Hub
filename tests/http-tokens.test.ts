import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createClientTokens,
  createLifecycle,
  memoryClientTokenStore,
  localClientTokenStore,
} from '@waleed/hub-core';
import {
  ClientTokenSchema,
  ClientTokensListSchema,
  CreateClientTokenRequestSchema,
  StreamableHttpHeadersSchema,
  StreamableHttpTransportSchema,
  IntegrationAgentIdSchema,
} from '@waleed/contracts';
import { memoryStore } from './helpers/memory-store.js';
import { profileState } from './helpers/runtime.js';
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.clearAllMocks();
});
function fixture() {
  const store = memoryClientTokenStore(),
    registry = memoryStore(profileState(['native']));
  let clock = Date.now();
  const service = createClientTokens({
    store,
    registry,
    mutation: async (action) => action(),
    assertWritable: async () => undefined,
    now: () => clock,
  });
  cleanup.push(async () => service.close());
  return {
    store,
    registry,
    service,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
it('generates unique 256-bit one-time tokens, stores SHA-256 only, and lists strict masked metadata', async () => {
  const f = fixture();
  const first = await f.service.create({
    expectedRevision: 0,
    label: '  Cursor desktop  ',
    agentId: 'cursor',
    profileId: 'profile',
  });
  const second = await f.service.create({
    expectedRevision: 1,
    label: 'Custom HTTP',
  });
  expect(first.plaintextToken).toMatch(/^wmh_live_[a-f0-9]{64}$/);
  expect(first.plaintextToken).not.toBe(second.plaintextToken);
  expect(first.token).toMatchObject({
    label: 'Cursor desktop',
    agentId: 'cursor',
    profileId: 'profile',
    tokenPreview: `wmh_live_...${first.plaintextToken.slice(-4)}`,
  });
  ClientTokenSchema.parse(first.token);
  const persisted = await f.store.read();
  expect(persisted.tokens[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(persisted)).not.toContain(first.plaintextToken);
  const listed = ClientTokensListSchema.parse(await f.service.list());
  expect(listed.tokens).toHaveLength(2);
  expect(JSON.stringify(listed)).not.toContain('hash');
  expect(JSON.stringify(listed)).not.toContain(first.plaintextToken);
  expect((await f.service.authenticate(first.plaintextToken))?.id).toBe(
    first.token.id,
  );
  expect(IntegrationAgentIdSchema.options).not.toContain('http-client');
});
it('compares every same-length SHA-256 with crypto.timingSafeEqual for matching and nonmatching credentials', async () => {
  const f = fixture(),
    tokens = [];
  for (let index = 0; index < 3; index++)
    tokens.push(
      await f.service.create({
        expectedRevision: index,
        label: `Client ${index}`,
      }),
    );
  vi.mocked(timingSafeEqual).mockClear();
  expect(await f.service.authenticate(tokens[0]!.plaintextToken)).toBeDefined();
  expect(timingSafeEqual).toHaveBeenCalledTimes(3);
  for (const call of vi.mocked(timingSafeEqual).mock.calls) {
    expect(call[0].byteLength).toBe(32);
    expect(call[1].byteLength).toBe(32);
  }
  vi.mocked(timingSafeEqual).mockClear();
  expect(
    await f.service.authenticate(`wmh_live_${'0'.repeat(64)}`),
  ).toBeUndefined();
  expect(timingSafeEqual).toHaveBeenCalledTimes(3);
});
it('revokes immediately and idempotently, notifies session owners, and survives a service restart', async () => {
  const f = fixture(),
    created = await f.service.create({
      expectedRevision: 0,
      label: 'Revoke me',
    }),
    invalidated = vi.fn();
  f.service.onInvalidate(invalidated);
  await f.service.revoke(created.token.id, { expectedRevision: 1 });
  expect(invalidated).toHaveBeenCalledWith(created.token.id);
  expect(await f.service.authenticate(created.plaintextToken)).toBeUndefined();
  await expect(
    f.service.requireActive(created.token.id),
  ).rejects.toHaveProperty('code', 'unavailable');
  expect((await f.service.list()).tokens[0]!.revokedAt).toBeDefined();
  await f.service.revoke(created.token.id, { expectedRevision: 2 });
  expect((await f.service.list()).revision).toBe(2);
  const restarted = createClientTokens({
    store: f.store,
    registry: f.registry,
    mutation: async (action) => action(),
    assertWritable: async () => undefined,
  });
  expect(await restarted.authenticate(created.plaintextToken)).toBeUndefined();
  restarted.close();
});
it('refuses expired tokens, stale revisions, missing/disabled profiles, unknown keys and past expiry', async () => {
  const f = fixture(),
    created = await f.service.create({
      expectedRevision: 0,
      label: 'Expiring',
      expiresAt: new Date(f.now() + 100).toISOString(),
    });
  f.advance(100);
  expect(await f.service.authenticate(created.plaintextToken)).toBeUndefined();
  await expect(
    f.service.create({ expectedRevision: 0, label: 'Stale' }),
  ).rejects.toHaveProperty('code', 'conflict');
  for (const extra of [
    { profileId: 'missing' },
    { expiresAt: new Date(f.now() - 1).toISOString() },
  ])
    await expect(
      f.service.create({ expectedRevision: 1, label: 'Refuse', ...extra }),
    ).rejects.toHaveProperty('code', 'invalid');
  await expect(
    f.service.create({
      expectedRevision: 1,
      label: 'x',
      plaintextToken: 'forbidden',
    }),
  ).rejects.toThrow();
  expect(
    CreateClientTokenRequestSchema.safeParse({
      expectedRevision: 1,
      label: ' '.repeat(10),
    }).success,
  ).toBe(false);
  await expect(
    f.service.revoke(created.token.id, { expectedRevision: 0 }),
  ).rejects.toHaveProperty('code', 'conflict');
});
it('fails closed on unreadable/corrupt token storage and failed revocation writes, without returning exception secrets', async () => {
  const f = fixture(),
    created = await f.service.create({
      expectedRevision: 0,
      label: 'Disk failure',
    });
  f.store.write = async () => {
    throw new Error('SYNTHETIC-PRIVATE-STORAGE-ERROR');
  };
  await expect(
    f.service.revoke(created.token.id, { expectedRevision: 1 }),
  ).rejects.toThrow();
  expect(await f.service.authenticate(created.plaintextToken)).toBeUndefined();
  f.store.read = async () => {
    throw new Error('SYNTHETIC-PRIVATE-STORAGE-ERROR');
  };
  await expect(
    f.service.authenticate(created.plaintextToken),
  ).rejects.toThrow();
});
it('enforces a bounded capacity and serializes token mutations with the lifecycle lock', async () => {
  const registry = memoryStore(profileState(['native'])),
    hub = createLifecycle(registry);
  cleanup.push(() => hub.close());
  const results = await Promise.allSettled([
    hub.http.tokens.create({ expectedRevision: 0, label: 'A' }),
    hub.http.tokens.create({ expectedRevision: 0, label: 'B' }),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const f = fixture();
  for (let index = 0; index < 256; index++)
    await f.service.create({
      expectedRevision: index,
      label: `Client ${index}`,
    });
  await expect(
    f.service.create({ expectedRevision: 256, label: 'Too many' }),
  ).rejects.toHaveProperty('code', 'conflict');
});
it('persists only private hashed tokens atomically with revision CAS/readback, and rejects hard links/corruption', async () => {
  const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\http-token-store-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const disk = localClientTokenStore(directory),
    registry = memoryStore(profileState(['native'])),
    service = createClientTokens({
      store: disk,
      registry,
      mutation: async (action) => action(),
      assertWritable: async () => undefined,
    });
  cleanup.push(async () => service.close());
  const created = await service.create({
      expectedRevision: 0,
      label: 'Persisted',
    }),
    text = await readFile(join(directory, 'http-tokens.json'), 'utf8');
  expect(text).not.toContain(created.plaintextToken);
  expect(text).toContain('hash');
  const restart = createClientTokens({
    store: localClientTokenStore(directory),
    registry,
    mutation: async (action) => action(),
    assertWritable: async () => undefined,
  });
  expect((await restart.authenticate(created.plaintextToken))?.id).toBe(
    created.token.id,
  );
  restart.close();
  await expect(
    disk.write(0, { revision: 1, tokens: [] }),
  ).rejects.toHaveProperty('code', 'conflict');
  await link(
    join(directory, 'http-tokens.json'),
    join(directory, 'hardlink.json'),
  );
  await expect(disk.read()).rejects.toThrow();
  await rm(join(directory, 'hardlink.json'));
  await writeFile(join(directory, 'http-tokens.json'), '{bad');
  await expect(disk.read()).rejects.toThrow();
});
it('contracts accept only loopback MCP URLs, Bearer tokens and bounded UUID session IDs', () => {
  for (const url of ['http://127.0.0.1:4177/mcp', 'http://[::1]:4177/mcp'])
    expect(
      StreamableHttpTransportSchema.safeParse({ type: 'streamable-http', url })
        .success,
    ).toBe(true);
  for (const url of [
    'http://evil.test/mcp',
    'http://127.0.0.1/mcp?token=secret',
    'http://secret@127.0.0.1/mcp',
  ])
    expect(
      StreamableHttpTransportSchema.safeParse({ type: 'streamable-http', url })
        .success,
    ).toBe(false);
  expect(
    StreamableHttpHeadersSchema.safeParse({
      authorization: `Bearer wmh_live_${'a'.repeat(64)}`,
    }).success,
  ).toBe(true);
  for (const authorization of [
    'Basic xxx',
    'Bearer a',
    'wmh_live_' + 'a'.repeat(64),
  ])
    expect(
      StreamableHttpHeadersSchema.safeParse({ authorization }).success,
    ).toBe(false);
});
