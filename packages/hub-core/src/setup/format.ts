import {
  ExportSetupBundleSchema,
  SETUP_MAX_BYTES,
  setupOverrideKey,
  type ExportSetupBundle,
  type SetupConnector,
  type HubState,
} from '@waleed/contracts';
import { HubError } from '../errors.js';
import {
  normalizeImport,
  clearImport,
  parseConfigurationJson,
  hasControlCharacters,
} from '../imports/normalize.js';
import type { SecretBackends } from '../auth/secrets.js';
import { assertNoCredentialEcho } from '../integrations/bridge.js';
import { assertBinding } from '../auth/bindings.js';

const invalid = () =>
  new HubError(
    'invalid',
    'Setup contains unsafe or nonportable values. Remove embedded credentials, traversal paths or unsupported commands; use required credential fields.',
  );
const literals: Record<string, readonly string[]> = {
  NODE_ENV: ['production', 'development', 'test'],
  NO_COLOR: ['1'],
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: ['1'],
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: ['1'],
};
const safeLiteral = (key: string, value: string) =>
  Object.hasOwn(literals, key) && literals[key]!.includes(value);
// This is a second line of defence, not a classifier for arbitrary passwords.
// Real credentials are compared below; unknown environment values never travel.
function checkPublic(
  value: unknown,
  privateValues: readonly string[] = [],
): void {
  if (typeof value === 'string') {
    if (
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
      }) ||
      /AQAAANCM|-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+)|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(
        value,
      ) ||
      /(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[=:]\s*\S+/i.test(
        value,
      ) ||
      privateValues.some(
        (secret) =>
          secret &&
          (value === secret || (secret.length >= 4 && value.includes(secret))),
      )
    )
      throw invalid();
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      try {
        const url = new URL(match[0]);
        if (url.username || url.password || url.search || url.hash)
          throw invalid();
      } catch {
        throw invalid();
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkPublic(item, privateValues);
    return;
  }
  if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (
        ['constructor', 'prototype', '__proto__'].includes(key) ||
        /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|ciphertext|encrypted(?:token|value|secret))$/i.test(
          key,
        )
      )
        throw invalid();
      checkPublic(key, privateValues);
      checkPublic(item, privateValues);
    }
}
function safePath(value: string) {
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw invalid();
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (
    /(?:^|[\\/=\s])\.\.(?:[\\/\s]|$)|(?:^|[\\/])\.(?:[\\/]|$)|\\\\|\$\{|\{(?:env|file):|%[A-Za-z_][A-Za-z0-9_]*%/.test(
      decoded,
    ) ||
    hasControlCharacters(decoded)
  )
    throw invalid();
}
export function validateSetup(bundle: ExportSetupBundle) {
  checkPublic(bundle);
  for (const connector of bundle.connectors) {
    for (const secret of connector.requiredSecrets)
      assertBinding(secret.target, secret.key, secret.format);
    for (const [key, value] of Object.entries(connector.environmentLiterals))
      if (!safeLiteral(key, value)) throw invalid();
    const values =
      connector.type === 'remote'
        ? [connector.url]
        : connector.type === 'native'
          ? [connector.command, ...connector.args]
          : connector.type === 'docker'
            ? [connector.image, ...connector.command, ...connector.args]
            : connector.args;
    for (const value of values) {
      safePath(value);
      if (
        /(?:^|[-_])(?:token|password|passwd|secret|api[-_]?key|authorization)(?:$|[=:\s])/i.test(
          value,
        )
      )
        throw invalid();
    }
    const common = {
      id: connector.id,
      name: connector.name,
      description: connector.description,
      enabled: connector.enabled,
      environmentLiterals: connector.environmentLiterals,
    };
    const source =
      connector.type === 'remote'
        ? {
            ...common,
            url: connector.url,
            transport: connector.transport,
            ...(connector.localHttpOptIn !== undefined
              ? { localHttpOptIn: connector.localHttpOptIn }
              : {}),
          }
        : connector.type === 'native'
          ? { ...common, command: connector.command, args: connector.args }
          : connector.type === 'docker'
            ? {
                ...common,
                image: connector.image,
                command: connector.command,
                args: connector.args,
                ...(connector.portBindings
                  ? { portBindings: connector.portBindings }
                  : {}),
              }
            : { ...common, package: connector.package, args: connector.args };
    const normalized = normalizeImport(JSON.stringify(source));
    try {
      if (
        normalized.entries.length !== 1 ||
        !normalized.entries[0]?.definition ||
        normalized.entries[0].issues.length
      )
        throw invalid();
    } finally {
      clearImport(normalized);
    }
  }
  return bundle;
}
export function parseSetup(source: string) {
  return validateSetup(
    ExportSetupBundleSchema.parse(
      parseConfigurationJson(source, SETUP_MAX_BYTES),
    ),
  );
}

export function projectSetup(state: HubState, now: number): ExportSetupBundle {
  const connectors: SetupConnector[] = state.connectors.map((connector) => {
    const requiredSecrets: SetupConnector['requiredSecrets'] = [],
      environmentLiterals: Record<string, string> = {};
    for (const key of Object.keys(connector.secretBindings))
      requiredSecrets.push({ key, target: 'environment', format: 'raw' });
    for (const [key, refId] of Object.entries(connector.headerBindings)) {
      const oauth = state.secretReferences.some(
        (ref) => ref.id === refId && ref.kind === 'oauth',
      );
      requiredSecrets.push({
        key,
        target: 'header',
        format: oauth
          ? 'bearer'
          : (connector.credentialFormats?.[key] ?? 'raw'),
        ...(oauth
          ? {
              description:
                'Supply a new access token or reconnect OAuth after import. OAuth accounts are not transferred.',
            }
          : {}),
      });
    }
    for (const [key, value] of Object.entries(
      connector.environmentLiterals ?? {},
    )) {
      if (safeLiteral(key, value)) environmentLiterals[key] = value;
      else if (
        !requiredSecrets.some(
          (secret) => secret.key.toLowerCase() === key.toLowerCase(),
        )
      )
        requiredSecrets.push({ key, target: 'environment', format: 'raw' });
    }
    const common = {
      id: connector.id,
      name: connector.name,
      description: connector.description,
      enabled: connector.enabled,
      environmentLiterals,
      requiredSecrets,
      policies: structuredClone(connector.toolPolicies ?? {}),
    };
    if (connector.executionMode === 'remote')
      return {
        ...common,
        type: 'remote',
        url: connector.endpoint,
        transport: connector.transport,
        ...(connector.localHttpOptIn !== undefined
          ? { localHttpOptIn: connector.localHttpOptIn }
          : {}),
      };
    if (connector.executionMode === 'native')
      return {
        ...common,
        type: 'native',
        command: connector.executable,
        args: [...connector.arguments],
      };
    if (connector.executionMode === 'docker')
      return {
        ...common,
        type: 'docker',
        image: connector.image,
        command: [...(connector.command ?? [])],
        args: [...connector.arguments],
        ...(connector.portBindings
          ? { portBindings: structuredClone(connector.portBindings) }
          : {}),
      };
    return {
      ...common,
      type: 'package',
      package: structuredClone(connector.package),
      args: [...connector.arguments],
    };
  });
  return ExportSetupBundleSchema.parse({
    version: 1,
    exportedAt: new Date(now).toISOString(),
    connectors,
    profiles: state.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      enabled: profile.enabled !== false,
      connectorIds: [...profile.connectorIds],
    })),
    agentProfileBindings: { ...state.agentProfileBindings },
    toolOverrides: Object.fromEntries(
      (state.toolOverrides ?? []).map((value) => [
        setupOverrideKey(value),
        structuredClone(value),
      ]),
    ),
  });
}
// Scan ALL known credentials, including unowned references and values duplicated
// into another connector/profile/override. Never export when that check is unavailable.
export async function assertSetupConfidential(
  bundle: ExportSetupBundle,
  state: HubState,
  backends: SecretBackends,
  extra: readonly string[] = [],
) {
  const values = [...extra];
  for (const connector of state.connectors)
    for (const [key, value] of Object.entries(
      connector.environmentLiterals ?? {},
    ))
      if (!safeLiteral(key, value)) values.push(value);
  const buffers: Buffer[] = [];
  try {
    for (const reference of state.secretReferences) {
      if (!reference.present) continue;
      const backend = backends[reference.adapter];
      if (!backend?.read)
        throw new HubError(
          'unavailable',
          'Export confidentiality requires readable protected credentials. Unlock the local vault before exporting.',
        );
      let bytes: Buffer;
      try {
        bytes = await backend.read(reference.id, AbortSignal.timeout(10_000));
      } catch {
        throw new HubError(
          'unavailable',
          'Protected credential inspection is unavailable. No setup was exported.',
        );
      }
      buffers.push(bytes);
      const text = bytes.toString('utf8');
      values.push(text);
      if (
        state.connectors.some((connector) =>
          Object.entries(connector.headerBindings).some(
            ([key, id]) =>
              id === reference.id &&
              connector.credentialFormats?.[key] === 'basic',
          ),
        )
      )
        values.push(`Basic ${text}`);
      if (reference.kind === 'oauth') {
        let tokens: Record<string, unknown>;
        try {
          tokens = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw invalid();
        }
        const collect = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (/token|secret|password/i.test(key) && typeof item === 'string')
              values.push(item);
            else if (item && typeof item === 'object') collect(item);
          }
        };
        collect(tokens);
      }
    }
    checkPublic(bundle, values);
    try {
      assertNoCredentialEcho(bundle, values);
    } catch {
      throw invalid();
    }
  } finally {
    for (const bytes of buffers) bytes.fill(0);
    values.fill('');
  }
}
