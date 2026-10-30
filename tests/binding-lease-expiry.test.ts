import { afterEach, describe, expect, it } from 'vitest';
import type { Connector, HubState } from '@waleed/contracts';
import { createBindingResolver, emptyState } from '@waleed/hub-core';
import { memorySecrets } from './helpers/secrets.js';

const now = 1_700_000_000_000;
const memories: ReturnType<typeof memorySecrets>[] = [];

afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
});

interface Reference {
  id: string;
  name: string;
  kind: 'oauth' | 'credential';
}

function setup(references: Reference[]) {
  const secrets = memorySecrets();
  memories.push(secrets);
  const connector: Connector = {
    id: 'connector-lease',
    name: 'Lease connector',
    description: '',
    executionMode: 'remote',
    transport: 'streamable_http',
    endpoint: 'https://example.test/mcp',
    environmentLiterals: {},
    secretBindings: {},
    headerBindings: Object.fromEntries(
      references.map((reference) => [reference.name, reference.id]),
    ),
    credentialFormats: Object.fromEntries(
      references.map((reference) => [reference.name, 'bearer']),
    ),
    trustApproval: null,
    enabled: true,
    revision: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
  const state: HubState = {
    ...emptyState(),
    connectors: [connector],
    secretReferences: references.map((reference) => ({
      id: reference.id,
      adapter: 'windows',
      present: true,
      ownerIds: [connector.id],
      kind: reference.kind,
    })),
  };
  const resolve = createBindingResolver(
    { windows: secrets.backend },
    async () => state,
    () => now,
  );
  const store = async (id: string, value: string) =>
    secrets.backend.put(id, Buffer.from(value), new AbortController().signal);
  return { secrets, connector, resolve, store };
}

describe('secret lease expiry', () => {
  it('keeps the smallest expiry of the resolved OAuth values', async () => {
    const { connector, resolve, store } = setup([
      { id: 'lease-a', name: 'Authorization', kind: 'oauth' },
      { id: 'lease-b', name: 'X-Second-Key', kind: 'oauth' },
    ]);
    await store(
      'lease-a',
      JSON.stringify({
        accessToken: 'synthetic-access-1',
        expiresAt: now + 600_000,
      }),
    );
    await store(
      'lease-b',
      JSON.stringify({
        accessToken: 'synthetic-access-2',
        expiresAt: now + 120_000,
      }),
    );

    const lease = await resolve(connector, new AbortController().signal);
    expect(lease.notAfter).toBe(now + 120_000);
    lease.dispose();
  });

  it('gives no expiry for a raw secret', async () => {
    const { connector, resolve, store } = setup([
      { id: 'lease-raw', name: 'Authorization', kind: 'credential' },
    ]);
    await store('lease-raw', 'synthetic-access-1');

    const lease = await resolve(connector, new AbortController().signal);
    expect(lease.notAfter).toBeUndefined();
    lease.dispose();
  });

  it('gives no expiry for an OAuth value without one', async () => {
    const { connector, resolve, store } = setup([
      { id: 'lease-null', name: 'Authorization', kind: 'oauth' },
    ]);
    await store(
      'lease-null',
      JSON.stringify({
        accessToken: 'synthetic-access-1',
        expiresAt: null,
      }),
    );

    const lease = await resolve(connector, new AbortController().signal);
    expect(lease.notAfter).toBeUndefined();
    lease.dispose();
  });
});
