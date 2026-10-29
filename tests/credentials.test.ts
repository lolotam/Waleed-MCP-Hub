import { afterEach, describe, expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  createBindingResolver,
  dockerSecretStore,
} from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';
import { profileState, apply } from './helpers/runtime.js';
import { memorySecrets } from './helpers/secrets.js';
import type { ProcessRequest } from '../packages/hub-core/src/ports.js';

const privateValue = 'SYNTHETIC-credential-private-0123456789';
const memories: ReturnType<typeof memorySecrets>[] = [];
function setup(mode: 'remote' | 'native' | 'docker' = 'remote') {
  const state = profileState([mode]);
  const store = memoryStore(state);
  const secrets = memorySecrets();
  memories.push(secrets);
  const safety = createMemorySafetyLedger();
  const hub = createLifecycle(store, Date.now, safety, {
    secrets: { windows: secrets.backend, docker: secrets.backend },
  });
  const input = {
    expectedRevision: 0,
    expectedConnectorRevision: 1,
    location: mode === 'remote' ? 'header' : 'environment',
    name: mode === 'remote' ? 'Authorization' : 'PROVIDER_TOKEN',
    format: mode === 'remote' ? 'bearer' : 'raw',
    adapter: mode === 'docker' ? 'docker' : 'windows',
    value: privateValue,
  };
  return { hub, store, safety, secrets, input };
}
afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
});
describe('one-way credential lifecycle', () => {
  it('fails unavailable backend preflight without changing state or blocking unrelated mutations', async () => {
    const { hub, secrets, safety, input } = setup();
    secrets.backend.has = async () => {
      throw new Error('SYNTHETIC-store-unavailable');
    };
    await expect(
      hub.auth.credentials.write('connector-0', input),
    ).rejects.toBeDefined();
    expect((await hub.inventory()).revision).toBe(0);
    expect((await safety.read()).operations).toEqual([]);
    expect(input.value).toBe('');
    expect(
      (
        await apply(hub, {
          kind: 'create_profile',
          name: 'Unrelated healthy workflow',
          description: '',
        })
      ).state,
    ).toBe('succeeded');
    await hub.close();
  });
  it('reports expired OAuth separately and zeros the decrypted bundle without forwarding it', async () => {
    const { hub, store, secrets, input } = setup();
    const value = Buffer.from(
      JSON.stringify({
        accessToken: privateValue,
        refreshToken: 'SYNTHETIC-refresh-only',
        clientId: 'public-client',
        expiresAt: Date.now() - 1000,
      }),
    );
    await hub.auth.credentials.commit(
      'connector-0',
      { ...input, location: 'header', adapter: 'windows', format: 'bearer' },
      value,
      { recipeId: 'fixture', carryApproval: true },
    );
    const resolve = createBindingResolver({ windows: secrets.backend }, () =>
      store.read(),
    );
    await expect(
      resolve((await store.read()).connectors[0]!, AbortSignal.timeout(1000)),
    ).rejects.toHaveProperty('reason', 'auth_expired');
    expect(value.every((byte) => byte === 0)).toBe(true);
    expect(
      secrets.reads.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
    await hub.close();
  });
  it('stores only a reference, clears caller input/buffers, invalidates approval/health and marks affected bindings', async () => {
    const { hub, secrets, input, safety } = setup();
    const receipt = await hub.auth.credentials.write('connector-0', input);
    expect(input.value).toBe('');
    expect(
      secrets.writes.every((value) => value.every((byte) => byte === 0)),
    ).toBe(true);
    expect(receipt).toMatchObject({
      present: true,
      revision: 2,
      requiresApproval: true,
    });
    const state = await hub.inventory();
    expect(state.connectors[0]!.trustApproval).toBeNull();
    expect(state.profiles[0]!.revision).toBe(2);
    expect(state.secretReferences[0]).toMatchObject({
      id: receipt.id,
      adapter: 'windows',
      present: true,
      ownerIds: ['connector-0'],
    });
    expect(
      JSON.stringify([
        state,
        receipt,
        await safety.read(),
        await hub.auth.status('connector-0'),
      ]),
    ).not.toContain(privateValue);
    await hub.close();
  });
  it.each([
    { location: 'header', name: 'Cookie' },
    { location: 'header', name: 'Host' },
    { location: 'header', name: 'X-Forwarded-Host' },
    { location: 'header', name: 'Mcp-Session-Id' },
    { location: 'environment', name: 'NODE_OPTIONS', format: 'raw' },
    { adapter: 'docker' },
    { expectedRevision: 99 },
    { expectedConnectorRevision: 99 },
    { value: 'line\r\nbreak' },
  ])(
    'fails closed without persisting an invalid binding %#',
    async (change) => {
      const { hub, input, secrets } = setup();
      await expect(
        hub.auth.credentials.write('connector-0', { ...input, ...change }),
      ).rejects.toBeDefined();
      expect(secrets.values.size).toBe(0);
      expect((await hub.inventory()).revision).toBe(0);
      await hub.close();
    },
  );
  it('only resolves declared owned bindings, formats headers explicitly, and zeros leases even after failure', async () => {
    const { hub, store, secrets, input } = setup();
    const receipt = await hub.auth.credentials.write('connector-0', input);
    const unused = `wmh-secret-${crypto.randomUUID()}`;
    await secrets.backend.put(
      unused,
      Buffer.from('SYNTHETIC-unrelated'),
      new AbortController().signal,
    );
    const resolve = createBindingResolver({ windows: secrets.backend }, () =>
      store.read(),
    );
    const connector = (await store.read()).connectors[0]!;
    const lease = await resolve(connector, new AbortController().signal);
    expect(lease.headers.Authorization).toBe(`Bearer ${privateValue}`);
    expect(secrets.idsRead).toEqual([receipt.id]);
    lease.dispose();
    expect(lease.headers).toEqual({});
    expect(
      secrets.reads.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
    connector.headerBindings['X-Other-Key'] =
      'wmh-secret-00000000-0000-0000-0000-000000000000';
    await expect(
      resolve(connector, new AbortController().signal),
    ).rejects.toHaveProperty('reason', 'secrets_pending');
    expect(
      secrets.reads.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
    await hub.close();
  });
  it('rotates immutably, prevents deletion while referenced, and distinguishes local deletion from provider revocation', async () => {
    const { hub, input, secrets } = setup();
    const first = await hub.auth.credentials.write('connector-0', input);
    await expect(
      hub.auth.credentials.delete(first.id, 1),
    ).rejects.toMatchObject({ code: 'conflict' });
    const second = await hub.auth.credentials.write('connector-0', {
      ...input,
      expectedRevision: 1,
      expectedConnectorRevision: 2,
      value: 'SYNTHETIC-new-private-value',
    });
    expect(second.id).not.toBe(first.id);
    expect(await hub.auth.credentials.delete(first.id, 2)).toEqual({
      id: first.id,
      present: false,
      providerRevoked: false,
    });
    expect(secrets.values.has(second.id)).toBe(true);
    await apply(hub, {
      kind: 'set_connector_enabled',
      connectorId: 'connector-0',
      enabled: false,
    });
    expect(secrets.values.has(second.id)).toBe(true);
    await hub.close();
  });
  it('prepares before secret writes, compensates failed registry commits and blocks ambiguous external writes', async () => {
    const good = setup();
    const put = good.secrets.backend.put;
    good.secrets.backend.put = async (...args) => {
      expect((await good.safety.read()).operations[0]?.phase).toBe('prepared');
      return put(...args);
    };
    good.store.write = async () => {
      throw new Error('SYNTHETIC-storage-failure');
    };
    await expect(
      good.hub.auth.credentials.write('connector-0', good.input),
    ).rejects.toBeDefined();
    expect(good.secrets.values.size).toBe(0);
    expect((await good.safety.read()).operations[0]?.phase).toBe('aborted');
    await good.hub.close();
    const bad = setup();
    bad.secrets.backend.put = async (...args) => {
      await put(...args);
      throw new Error('SYNTHETIC-uncertain');
    };
    await expect(
      bad.hub.auth.credentials.write('connector-0', bad.input),
    ).rejects.toBeDefined();
    expect((await bad.safety.read()).operations[0]?.phase).toBe('needs_review');
    expect(
      bad.secrets.writes.every((buffer) => buffer.every((byte) => byte === 0)),
    ).toBe(true);
    await bad.hub.close();
  });
  it('serializes writes against registry operations and rejects stale parallel credential submissions', async () => {
    const { hub, input, secrets } = setup();
    const tasks = await Promise.allSettled([
      hub.auth.credentials.write('connector-0', { ...input }),
      hub.auth.credentials.write('connector-0', { ...input }),
    ]);
    expect(tasks.filter((task) => task.status === 'fulfilled')).toHaveLength(1);
    expect(secrets.values.size).toBe(1);
    await hub.close();
  });
});

describe('documented Docker secret interface', () => {
  it('accepts a post-delete CLI failure only when exact metadata read-back proves absence', async () => {
    const id = `wmh-secret-${crypto.randomUUID()}`;
    let present = true;
    const command = {
      executable: 'C:\\Synthetic\\docker.exe',
      environment: {},
      async run(args: readonly string[]) {
        if (args[2] === 'rm') {
          present = false;
          throw new Error('SYNTHETIC-post-delete-error');
        }
        return JSON.stringify(present ? [{ name: id }] : []);
      },
    };
    const backend = dockerSecretStore(command, {
      async run() {
        throw new Error('No write is needed.');
      },
    });
    await backend.delete(id, AbortSignal.timeout(1000));
    expect(await backend.has(id, AbortSignal.timeout(1000))).toBe(false);
    command.run = async (args) => {
      if (args[2] === 'rm') throw new Error('SYNTHETIC-delete-refused');
      return JSON.stringify([{ name: id }]);
    };
    await expect(
      backend.delete(id, AbortSignal.timeout(1000)),
    ).rejects.toBeDefined();
  });
  it('uses stdin exclusively, checks presence with metadata, refuses foreign IDs and never invents a plaintext read', async () => {
    const calls: ProcessRequest[] = [];
    const names = new Set<string>();
    const command = {
      executable: 'C:\\Synthetic\\docker.exe',
      environment: {},
      async run(args: readonly string[]) {
        if (args[2] === 'rm') {
          names.delete(args[3]!);
          return '';
        }
        return JSON.stringify(
          [...names].map((name) => ({ name, provider: 'credstore' })),
        );
      },
    };
    const backend = dockerSecretStore(command, {
      async run(request) {
        calls.push(request);
        names.add(request.arguments[3]!);
        return { outcome: 'exited', exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const id = `wmh-secret-${crypto.randomUUID()}`,
      value = Buffer.from(privateValue);
    await backend.put(id, value, new AbortController().signal);
    expect(calls[0]!.arguments).toEqual(['mcp', 'secret', 'set', id]);
    expect(calls[0]!.arguments.join(' ')).not.toContain(privateValue);
    expect(calls[0]!.stdin).toBe(privateValue);
    expect(backend.read).toBeUndefined();
    await expect(
      backend.put('existing-pilot-secret', value, new AbortController().signal),
    ).rejects.toBeDefined();
    await backend.delete(id, new AbortController().signal);
    expect(await backend.has(id, new AbortController().signal)).toBe(false);
    value.fill(0);
  });
});
