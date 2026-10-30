import type { Connector, HubState } from '@waleed/contracts';
import { HubError } from '../errors.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import type { SecretBackends } from './secrets.js';
import { assertSecretId } from './secrets.js';

const forbiddenEnvironment =
  /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSAFEPATH|PYTHONNOUSERSITE|PYTHONDONTWRITEBYTECODE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+|XDG_.+|DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|PSMODULEPATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|NPM_CONFIG_.+|UV_.+|PIP_.+|DOCKER_.+|WMH_.+)$/i;
export function assertBinding(
  location: 'environment' | 'header',
  name: string,
  format: string,
) {
  if (location === 'environment') {
    if (
      !/^[A-Z_][A-Z0-9_]{0,99}$/.test(name) ||
      forbiddenEnvironment.test(name) ||
      format !== 'raw'
    )
      throw new HubError(
        'invalid',
        'Only non-runtime credential environment bindings are supported.',
      );
  } else if (
    !/^(?:Authorization|X-[A-Za-z0-9-]+|Api-Key)$/i.test(name) ||
    /^(?:x-forwarded-|x-csrf-|x-mcp-)/i.test(name)
  )
    throw new HubError(
      'invalid',
      'Choose a supported credential header, not transport/session headers.',
    );
}
export interface SecretLease {
  environment: Record<string, string>;
  headers: Record<string, string>;
  // Docker resolves these references inside its gateway. Never decrypt them here.
  dockerSecrets?: Array<{ name: string; env: string }>;
  expiresAt?: number;
  dispose(): void;
}
export function createBindingResolver(
  backends: SecretBackends,
  readState: () => Promise<HubState>,
  now: () => number = Date.now,
) {
  return async (
    connector: Connector,
    signal: AbortSignal,
  ): Promise<SecretLease> => {
    const state = await readState();
    const buffers: Buffer[] = [];
    const environment: Record<string, string> = {},
      headers: Record<string, string> = {};
    const dockerSecrets: Array<{ name: string; env: string }> = [];
    let expiresAt: number | undefined;
    const dispose = () => {
      buffers.forEach((buffer) => buffer.fill(0));
      for (const key of Object.keys(environment)) delete environment[key];
      for (const key of Object.keys(headers)) delete headers[key];
      dockerSecrets.length = 0;
    };
    try {
      if (
        connector.executionMode === 'docker' &&
        Object.keys(connector.headerBindings).length
      )
        throw new RuntimeFault('secrets_pending');
      for (const location of ['environment', 'header'] as const) {
        const bindings =
          location === 'environment'
            ? connector.secretBindings
            : connector.headerBindings;
        const seen = new Set<string>();
        for (const [name, id] of Object.entries(bindings)) {
          const format =
            location === 'header'
              ? (connector.credentialFormats?.[name] ?? 'raw')
              : 'raw';
          assertBinding(location, name, format);
          if (seen.has(name.toLowerCase()))
            throw new RuntimeFault('secrets_pending');
          seen.add(name.toLowerCase());
          const reference = state.secretReferences.find(
            (reference) => reference.id === id,
          );
          if (!reference?.present || !reference.ownerIds.includes(connector.id))
            throw new RuntimeFault('secrets_pending');
          if (connector.executionMode === 'docker') {
            assertSecretId(id);
            if (
              reference.adapter !== 'docker' ||
              reference.kind === 'oauth' ||
              !backends.docker ||
              Object.hasOwn(connector.environmentLiterals ?? {}, name) ||
              !(await backends.docker.has(id, signal))
            )
              throw new RuntimeFault('secrets_pending');
            dockerSecrets.push({ name: id, env: name });
            continue;
          }
          const backend =
            reference.adapter === 'docker'
              ? undefined
              : backends[reference.adapter];
          if (!backend?.read) throw new RuntimeFault('secrets_pending');
          const value = await backend.read(id, signal);
          buffers.push(value);
          let text = value.toString('utf8');
          if (reference.kind === 'oauth') {
            const token = JSON.parse(text) as {
              accessToken?: unknown;
              expiresAt?: unknown;
            };
            if (
              typeof token.accessToken !== 'string' ||
              !token.accessToken ||
              (typeof token.expiresAt !== 'number' && token.expiresAt !== null)
            )
              throw new RuntimeFault('secrets_pending');
            if (
              typeof token.expiresAt === 'number' &&
              token.expiresAt <= now() + 30_000
            )
              throw new RuntimeFault('auth_expired');
            if (typeof token.expiresAt === 'number')
              expiresAt = Math.min(
                expiresAt ?? Infinity,
                token.expiresAt - 30_000,
              );
            text = token.accessToken;
          }
          if (location === 'header') {
            if (/[\r\n\0]/.test(text))
              throw new RuntimeFault('secrets_pending');
            headers[name] =
              format === 'bearer'
                ? `Bearer ${text}`
                : format === 'basic'
                  ? `Basic ${text}`
                  : text;
          } else environment[name] = text;
        }
      }
      return {
        environment,
        headers,
        ...(connector.executionMode === 'docker' ? { dockerSecrets } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        dispose,
      };
    } catch (error) {
      dispose();
      throw error instanceof RuntimeFault
        ? error
        : new RuntimeFault('secrets_pending');
    }
  };
}
