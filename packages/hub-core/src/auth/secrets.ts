import { HubError } from '../errors.js';
import type {
  NativeSecretAdapter,
  CredentialStorageStatus,
} from '@waleed/contracts';
export interface CredentialStorageDiagnostics {
  status(): CredentialStorageStatus;
  check(): Promise<CredentialStorageStatus>;
}

// Values cross internal seams as short-lived mutable buffers. Backends never
// expose a read operation to HTTP callers. Docker deliberately has no read seam.
export interface SecretBackend {
  // put borrows its input; read transfers a mutable buffer to the caller.
  // The credential transaction/lease owner zeros those buffers on release.
  put(id: string, value: Buffer, signal: AbortSignal): Promise<void>;
  has(id: string, signal: AbortSignal): Promise<boolean>;
  delete(id: string, signal: AbortSignal): Promise<void>;
  read?(id: string, signal: AbortSignal): Promise<Buffer>;
  // OAuth rotation keeps a stable reference. The caller must hold this backend's
  // cross-process lock through read, provider refresh, and encrypted replacement.
  lock?(id: string, signal: AbortSignal): Promise<() => Promise<void>>;
  replace?(id: string, value: Buffer, signal: AbortSignal): Promise<void>;
}
export interface SecretBackends {
  windows?: SecretBackend;
  keychain?: SecretBackend;
  libsecret?: SecretBackend;
  docker?: SecretBackend;
}
// `windows` is the persisted DPAPI reference ID, not an alias for any OS vault.
// Never read a DPAPI reference from Keychain/libsecret after moving a registry.
export function nativeSecretAdapter(
  backends: SecretBackends,
): NativeSecretAdapter {
  const configured = (['windows', 'keychain', 'libsecret'] as const).filter(
    (id) => !!backends[id],
  );
  if (configured.length > 1)
    throw new HubError(
      'unavailable',
      'Exactly one native credential backend may be configured.',
    );
  if (configured[0]) return configured[0];
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'keychain';
  if (process.platform === 'linux') return 'libsecret';
  throw new HubError(
    'unavailable',
    'No native credential adapter exists for this platform.',
  );
}
export function assertSecretId(id: string) {
  if (!/^wmh-secret-[a-f0-9-]{36}$/.test(id))
    throw new HubError(
      'invalid',
      'Only generated owned secret identifiers are supported.',
    );
}
export function assertSecretValue(value: Buffer) {
  if (
    !Buffer.isBuffer(value) ||
    !value.length ||
    value.length > 8192 ||
    value.includes(0)
  )
    throw new HubError(
      'invalid',
      'Credential is empty or exceeds supported limits.',
    );
}
