import { HubError } from '../errors.js';

// Values cross internal seams as short-lived mutable buffers. Backends never
// expose a read operation to HTTP callers. Docker deliberately has no read seam.
export interface SecretBackend {
  put(id: string, value: Buffer, signal: AbortSignal): Promise<void>;
  has(id: string, signal: AbortSignal): Promise<boolean>;
  delete(id: string, signal: AbortSignal): Promise<void>;
  read?(id: string, signal: AbortSignal): Promise<Buffer>;
}
export interface SecretBackends {
  windows?: SecretBackend;
  docker?: SecretBackend;
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
