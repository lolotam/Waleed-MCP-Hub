import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  createKeyringSecretBackend,
  createPlatformCredentialStorage,
  createBindingResolver,
  createLifecycle,
  HubError,
  type SecretCommand,
  type SecretCommandRunner,
} from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';
import { profileState } from './helpers/runtime.js';
import { StateSchema } from '@waleed/contracts';

function keyringFixture(kind: 'keychain' | 'libsecret') {
  const entries = new Map<string, string>(),
    commands: SecretCommand[] = [],
    released: Buffer[] = [],
    inputs: Buffer[] = [];
  let denied = false,
    malformed = false,
    failDelete = false;
  const run: SecretCommandRunner = async (command) => {
    commands.push(command);
    if (command.stdin) inputs.push(command.stdin);
    const args = [...command.arguments],
      operation = args[0];
    const id =
      kind === 'keychain'
        ? operation === '-q'
          ? / -a ([^ ]+) /.exec(command.stdin!.toString())?.[1]
          : args[args.indexOf('-a') + 1]
        : args[args.indexOf('id') + 1];
    let code = 0,
      text = '',
      error = '';
    if (denied) {
      code = 1;
      error = 'SYNTHETIC-PRIVATE-KEYRING-ERROR';
    } else if (
      operation === 'find-generic-password' ||
      operation === 'lookup'
    ) {
      if (entries.has(id!))
        text = malformed
          ? 'SYNTHETIC-INVALID-KEYRING-OUTPUT'
          : `${entries.get(id!)}\n`;
      else code = kind === 'keychain' ? 44 : 1;
    } else if (operation === '-q')
      entries.set(id!, / -w ([^\n]+)\n/.exec(command.stdin!.toString())![1]!);
    else if (operation === 'store') entries.set(id!, command.stdin!.toString());
    else if (!failDelete) entries.delete(id!);
    const stdout = Buffer.from(text),
      stderr = Buffer.from(error);
    released.push(stdout, stderr);
    return {
      exitCode: code,
      stdout,
      stderr,
      dispose() {
        stdout.fill(0);
        stderr.fill(0);
      },
    };
  };
  const scope = randomUUID();
  const backend = createKeyringSecretBackend({
    kind,
    scope,
    run,
  });
  return {
    backend,
    scope,
    entries,
    commands,
    released,
    inputs,
    run,
    deny() {
      denied = true;
    },
    malform() {
      malformed = true;
    },
    failDelete() {
      failDelete = true;
    },
  };
}
const signal = () => AbortSignal.timeout(5000);
it.each(['keychain', 'libsecret'] as const)(
  '%s stores, reads, verifies and deletes owned secrets without values in argv or unzeroed CLI buffers',
  async (kind) => {
    const f = keyringFixture(kind),
      id = `wmh-secret-${randomUUID()}`,
      value = Buffer.from('SYNTHETIC-秘密\n"quoted" value\n');
    expect(await f.backend.has(id, signal())).toBe(false);
    await f.backend.put(id, value, signal());
    expect(await f.backend.has(id, signal())).toBe(true);
    const read = await f.backend.read!(id, signal());
    expect(read).toEqual(value);
    read.fill(0);
    await expect(f.backend.put(id, value, signal())).rejects.toHaveProperty(
      'code',
      'conflict',
    );
    await f.backend.delete(id, signal());
    expect(await f.backend.has(id, signal())).toBe(false);
    for (const command of f.commands) {
      expect(JSON.stringify(command.arguments)).not.toContain('SYNTHETIC');
      expect(command.executable).toBe(
        kind === 'keychain' ? '/usr/bin/security' : '/usr/bin/secret-tool',
      );
    }
    if (kind === 'keychain')
      expect(
        f.commands.some(
          (command) =>
            command.arguments[0] === '-q' && command.arguments.includes('-i'),
        ),
      ).toBe(true);
    else
      expect(
        f.commands.find((command) => command.arguments[0] === 'store')!
          .arguments,
      ).toEqual(
        expect.arrayContaining([
          'application',
          'waleed-mcp-hub',
          'scope',
          'id',
        ]),
      );
    for (const bytes of [...f.released, ...f.inputs])
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    value.fill(0);
  },
);
it.each(['keychain', 'libsecret'] as const)(
  '%s fails closed on a locked/denied/malformed keyring, aborted operations and unconfirmed deletion',
  async (kind) => {
    const f = keyringFixture(kind),
      id = `wmh-secret-${randomUUID()}`,
      value = Buffer.from('SYNTHETIC-valid');
    await f.backend.put(id, value, signal());
    f.failDelete();
    await expect(f.backend.delete(id, signal())).rejects.toHaveProperty(
      'code',
      'unavailable',
    );
    f.malform();
    await expect(f.backend.read!(id, signal())).rejects.toHaveProperty(
      'code',
      'unavailable',
    );
    f.deny();
    await expect(f.backend.has(id, signal())).rejects.toThrow(
      'No plaintext fallback',
    );
    await expect(
      f.backend.put(`wmh-secret-${randomUUID()}`, value, signal()),
    ).rejects.toHaveProperty('code', 'unavailable');
    const aborted = new AbortController();
    aborted.abort();
    await expect(f.backend.read!(id, aborted.signal)).rejects.toThrow();
    await expect(
      f.backend.delete('../../foreign', signal()),
    ).rejects.toHaveProperty('code', 'invalid');
    value.fill(0);
    for (const bytes of f.released)
      expect(bytes.every((byte) => byte === 0)).toBe(true);
  },
);
it.each([
  ['win32', 'dpapi', 'windows'],
  ['darwin', 'keychain', 'keychain'],
  ['linux', 'libsecret', 'libsecret'],
] as const)(
  '%s factory selects %s lazily and retries unavailable system storage without a fallback',
  async (platform, kind, adapter) => {
    const f = keyringFixture(kind === 'dpapi' ? 'keychain' : kind),
      open = vi.fn(async () => f.backend);
    const storage = createPlatformCredentialStorage({
      directory: 'not-used-by-injected-adapter',
      platform,
      open: { [kind]: open },
    });
    expect(open).not.toHaveBeenCalled();
    expect(storage.status()).toMatchObject({
      backend: kind,
      state: 'not_checked',
    });
    expect(storage.referenceAdapter).toBe(adapter);
    expect((await storage.check()).state).toBe('available');
    expect(open).toHaveBeenCalledTimes(1);
    f.deny();
    expect((await storage.check()).state).toBe('unavailable');
    expect((await storage.check()).state).toBe('unavailable');
    expect(open).toHaveBeenCalledTimes(2);
    expect(Object.keys(storage.backends)).toEqual([adapter]);
  },
);
it('unknown platforms report a graceful capability error and have no plaintext or ephemeral automatic fallback', async () => {
  const storage = createPlatformCredentialStorage({
    directory: 'unused',
    platform: 'freebsd',
  });
  expect(storage.backends).toEqual({});
  expect(await storage.check()).toMatchObject({
    backend: 'unavailable',
    state: 'unavailable',
    containment: 'unavailable',
  });
});
it('a failed namespace/protection probe reports unavailable rather than remaining not checked', async () => {
  const storage = createPlatformCredentialStorage({
    directory: 'unused',
    platform: 'darwin',
    open: {
      keychain: async () => {
        throw new HubError('conflict', 'SYNTHETIC-PRIVATE-NAMESPACE-ERROR');
      },
    },
  });
  const status = await storage.check();
  expect(status).toMatchObject({
    backend: 'keychain',
    state: 'unavailable',
    checkedAt: expect.any(String),
  });
  expect(JSON.stringify(status)).not.toContain('SYNTHETIC-PRIVATE');
});
it.each(['keychain', 'libsecret'] as const)(
  '%s refuses unverified writes and zeros captured output/input on that failure',
  async (kind) => {
    const f = keyringFixture(kind),
      value = Buffer.from('SYNTHETIC-VERIFY-SECRET');
    f.malform();
    try {
      await expect(
        f.backend.put(`wmh-secret-${randomUUID()}`, value, signal()),
      ).rejects.toHaveProperty('code', 'unavailable');
      for (const bytes of [...f.released, ...f.inputs])
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      value.fill(0);
    }
  },
);
it.each(['keychain', 'libsecret'] as const)(
  '%s read-only construction can read existing values but cannot mutate or delete the OS item',
  async (kind) => {
    const f = keyringFixture(kind),
      id = `wmh-secret-${randomUUID()}`,
      value = Buffer.from('SYNTHETIC-READONLY');
    try {
      await f.backend.put(id, value, signal());
      const readOnly = createKeyringSecretBackend({
        kind,
        scope: f.scope,
        run: f.run,
        readOnly: true,
      });
      const bytes = await readOnly.read!(id, signal());
      try {
        expect(bytes).toEqual(value);
      } finally {
        bytes.fill(0);
      }
      await expect(readOnly.put(id, value, signal())).rejects.toHaveProperty(
        'code',
        'unavailable',
      );
      await expect(readOnly.delete(id, signal())).rejects.toHaveProperty(
        'code',
        'unavailable',
      );
      expect(await readOnly.has(id, signal())).toBe(true);
    } finally {
      value.fill(0);
    }
  },
);
it('refuses Keychain values exceeding the native interactive line bound before any store command is sent', async () => {
  const f = keyringFixture('keychain'),
    value = Buffer.alloc(8192, 65);
  try {
    await expect(
      f.backend.put(`wmh-secret-${randomUUID()}`, value, signal()),
    ).rejects.toHaveProperty('code', 'invalid');
    expect(f.entries.size).toBe(0);
    expect(
      f.commands.every(
        (command) => command.arguments[0] === 'find-generic-password',
      ),
    ).toBe(true);
  } finally {
    value.fill(0);
  }
});
it.each(['keychain', 'libsecret'] as const)(
  '%s participates in the existing credential transaction, reference binding and zero-filled lease lifecycle',
  async (kind) => {
    const f = keyringFixture(kind),
      store = memoryStore(profileState(['remote'])),
      hub = createLifecycle(store, Date.now, undefined, {
        secrets: { [kind]: f.backend },
      });
    try {
      const raw = {
        expectedRevision: 0,
        expectedConnectorRevision: 1,
        location: 'header',
        name: 'Authorization',
        format: 'bearer',
        adapter: kind,
        value: 'SYNTHETIC-owned-secret',
      };
      await hub.auth.credentials.write('connector-0', raw);
      expect(raw.value).toBe('');
      const state = StateSchema.parse(await store.read());
      expect(state.secretReferences[0]!.adapter).toBe(kind);
      expect(JSON.stringify(state)).not.toContain('SYNTHETIC-owned-secret');
      const returned: Buffer[] = [],
        read = f.backend.read!.bind(f.backend);
      f.backend.read = async (id, signal) => {
        const bytes = await read(id, signal);
        returned.push(bytes);
        return bytes;
      };
      const lease = await createBindingResolver({ [kind]: f.backend }, () =>
        store.read(),
      )(state.connectors[0]!, signal());
      expect(lease.headers.Authorization).toBe('Bearer SYNTHETIC-owned-secret');
      lease.dispose();
      expect(lease.headers).toEqual({});
      expect(returned[0]!.every((byte) => byte === 0)).toBe(true);
      await expect(
        createBindingResolver({ windows: f.backend }, () => store.read())(
          state.connectors[0]!,
          signal(),
        ),
      ).rejects.toHaveProperty('reason', 'secrets_pending');
    } finally {
      await hub.close();
    }
  },
);
