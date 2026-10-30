import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import type {
  CredentialStorageStatus,
  NativeSecretAdapter,
  SecretStorageKind,
} from '@waleed/contracts';
import type {
  SecretBackend,
  SecretBackends,
  CredentialStorageDiagnostics,
} from '../../auth/secrets.js';
import { windowsSecretStore } from './windows.js';
import { createKeyringSecretBackend } from './keyring.js';
import { keyringCommandRunner } from './keyring-command.js';
import { assertNoLinks } from '../managed-files.js';
import { agentFiles } from '../../integrations/files.js';
import { HubError } from '../../errors.js';

const unavailable = () =>
  new HubError(
    'unavailable',
    'The selected platform credential backend is unavailable. No plaintext fallback was used.',
  );
const names = {
  dpapi: 'Windows DPAPI',
  keychain: 'macOS Keychain',
  libsecret: 'Linux Secret Service / libsecret',
  unavailable: 'Unavailable',
} as const;
export function platformSecretKind(platform: string): SecretStorageKind {
  return platform === 'win32'
    ? 'dpapi'
    : platform === 'darwin'
      ? 'keychain'
      : platform === 'linux'
        ? 'libsecret'
        : 'unavailable';
}
export function unconfiguredCredentialStorage(
  platform = process.platform,
): CredentialStorageDiagnostics {
  const backend = platformSecretKind(platform);
  const status = (): CredentialStorageStatus => ({
    backend,
    name: names[backend],
    state: 'not_configured',
    checkedAt: null,
    containment:
      platform === 'win32'
        ? 'windows-job-object'
        : ['darwin', 'linux'].includes(platform)
          ? 'posix-process-group'
          : 'unavailable',
  });
  return {
    status,
    async check() {
      return status();
    },
  };
}
async function keyringScope(directory: string, readOnly: boolean) {
  await assertNoLinks(directory, true);
  if (!readOnly) await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoLinks(directory);
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw unavailable();
  const path = join(directory, 'keyring-scope.json'),
    files = agentFiles([path], join(directory, 'unused-keyring-backups'));
  let text = await files.read(path);
  if (text === null) {
    if (readOnly) throw unavailable();
    text = JSON.stringify({ version: 1, scope: randomUUID() });
    await files.replace(path, null, text);
  }
  if (((await lstat(path)).mode & 0o077) !== 0) throw unavailable();
  if (Buffer.byteLength(text) > 256) throw unavailable();
  const scope = JSON.parse(text) as { version?: unknown; scope?: unknown };
  if (
    !scope ||
    Object.keys(scope).sort().join(',') !== 'scope,version' ||
    scope.version !== 1 ||
    typeof scope.scope !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(scope.scope)
  )
    throw unavailable();
  return scope.scope;
}
export function createPlatformCredentialStorage({
  directory,
  environment = process.env,
  platform = process.platform,
  readOnly = false,
  open,
}: {
  directory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: string;
  readOnly?: boolean;
  // Internal adapter-construction seam. Never accepted from an HTTP request.
  open?: Partial<
    Record<
      Exclude<SecretStorageKind, 'unavailable'>,
      () => Promise<SecretBackend>
    >
  >;
}) {
  const kind = platformSecretKind(platform);
  const referenceAdapter: NativeSecretAdapter | undefined =
    kind === 'dpapi' ? 'windows' : kind === 'unavailable' ? undefined : kind;
  let backend: Promise<SecretBackend> | undefined;
  let state: CredentialStorageStatus['state'] =
    kind === 'unavailable' ? 'unavailable' : 'not_checked';
  let checkedAt: string | null = null;
  const status = (): CredentialStorageStatus => ({
    backend: kind,
    name: names[kind],
    state,
    checkedAt,
    containment:
      platform === 'win32'
        ? 'windows-job-object'
        : ['darwin', 'linux'].includes(platform)
          ? 'posix-process-group'
          : 'unavailable',
  });
  const initialize = async () => {
    if (kind === 'unavailable') throw unavailable();
    if (open?.[kind]) return open[kind]!();
    if (platform !== process.platform) throw unavailable();
    if (kind === 'dpapi') return windowsSecretStore(directory, readOnly);
    const scope = await keyringScope(directory, readOnly);
    return createKeyringSecretBackend({
      kind,
      scope,
      readOnly,
      run: keyringCommandRunner(directory, environment),
    });
  };
  async function use<T>(
    action: (backend: SecretBackend) => Promise<T>,
  ): Promise<T> {
    try {
      const protectedBackend = await (backend ??= initialize().catch(() => {
        throw unavailable();
      }));
      const result = await action(protectedBackend);
      state = 'available';
      checkedAt = new Date().toISOString();
      return result;
    } catch (error) {
      if (error instanceof HubError && error.code !== 'unavailable')
        throw error;
      backend = undefined;
      state = 'unavailable';
      checkedAt = new Date().toISOString();
      throw unavailable();
    }
  }
  const write = <T>(
    action: (backend: SecretBackend) => Promise<T>,
  ): Promise<T> => (readOnly ? Promise.reject(unavailable()) : use(action));
  const adapter: SecretBackend = {
    has: (id, signal) => use((backend) => backend.has(id, signal)),
    put: (id, value, signal) =>
      write((backend) => backend.put(id, value, signal)),
    read: (id, signal) =>
      use((backend) => {
        if (!backend.read) throw unavailable();
        return backend.read(id, signal);
      }),
    delete: (id, signal) => write((backend) => backend.delete(id, signal)),
    // DPAPI rotation retains its existing cross-process lock and encrypted replace.
    ...(kind === 'dpapi'
      ? {
          lock: (id: string, signal: AbortSignal) =>
            write((backend) => {
              if (!backend.lock) throw unavailable();
              return backend.lock(id, signal);
            }),
          replace: (id: string, value: Buffer, signal: AbortSignal) =>
            write((backend) => {
              if (!backend.replace) throw unavailable();
              return backend.replace(id, value, signal);
            }),
        }
      : {}),
  };
  const backends: SecretBackends = referenceAdapter
    ? { [referenceAdapter]: adapter }
    : {};
  return {
    backends,
    referenceAdapter,
    status,
    async check() {
      try {
        await adapter.has(
          `wmh-secret-${randomUUID()}`,
          AbortSignal.timeout(12_000),
        );
      } catch {
        /* Status is metadata-only; never return native/CLI error text. */
        backend = undefined;
        state = 'unavailable';
        checkedAt = new Date().toISOString();
      }
      return status();
    },
  };
}
export type PlatformCredentialStorage = ReturnType<
  typeof createPlatformCredentialStorage
>;
