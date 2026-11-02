import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { parseTree, getNodeValue, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import type {
  AdoptionCandidate,
  FileObservation,
  DiscoverySnapshot,
} from '@waleed/contracts';
import type { ReadResult } from './ports.js';
import { HubError } from '../errors.js';

export function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}
export const strings = (value: unknown): string[] | null =>
  Array.isArray(value) &&
  value.length <= 128 &&
  value.every((item) => typeof item === 'string' && item.length <= 4096)
    ? (value as string[])
    : null;
// V1 names servers directly under mcp; V2 wraps them under mcp.servers.
// A direct server called servers (including an enabled-only V1 override)
// keeps its own fields instead of being mistaken for the wrapper.
export function openCodeServerLayout(value: unknown) {
  const mcp = object(value);
  const nested = object(mcp?.servers);
  const wrapper = nested && !openCodeServerRecord(nested) ? nested : null;
  const siblings = Object.entries(mcp ?? {}).filter(
    ([name, entry]) =>
      (name !== 'servers' || !wrapper) &&
      (name !== 'timeout' || !openCodeTimeoutSetting(entry)),
  );
  if (!wrapper)
    return {
      servers: mcp ? Object.fromEntries(siblings) : null,
      wrapped: false,
    };
  for (const [name] of siblings) {
    if (Object.hasOwn(wrapper, name))
      throw new HubError('conflict', 'Conflicting OpenCode server maps.');
  }
  return {
    servers: siblings.length
      ? { ...wrapper, ...Object.fromEntries(siblings) }
      : wrapper,
    wrapped: true,
  };
}
export function openCodeServers(value: unknown) {
  return openCodeServerLayout(value).servers;
}
function openCodeServerRecord(value: unknown) {
  const entry = object(value);
  if (!entry) return false;
  if (validOpenCodeEntry(entry)) return true;
  const wrappedSibling = Object.values(entry).some((candidate) => {
    const child = object(candidate);
    return child !== null && validOpenCodeEntry(child);
  });
  // A malformed direct record must not become a destination for new servers.
  // A healthy child distinguishes a wrapper with malformed reserved names.
  return (
    !wrappedSibling &&
    ['type', 'command', 'url', 'enabled', 'disabled'].some((key) =>
      Object.hasOwn(entry, key),
    )
  );
}
function openCodeTimeoutSetting(value: unknown) {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0;
  const settings = object(value);
  return (
    settings !== null &&
    Object.entries(settings).every(
      ([key, milliseconds]) =>
        ['startup', 'catalog', 'execution'].includes(key) &&
        typeof milliseconds === 'number' &&
        Number.isSafeInteger(milliseconds) &&
        milliseconds > 0,
    )
  );
}
export function validOpenCodeEntry(entry: Record<string, unknown>) {
  if (Object.keys(entry).length === 1 && typeof entry.enabled === 'boolean')
    return true;
  if (
    ['enabled', 'disabled'].some(
      (key) => entry[key] !== undefined && typeof entry[key] !== 'boolean',
    )
  )
    return false;
  if (entry.type === 'local') {
    const command = strings(entry.command);
    return Boolean(command?.length && command[0]?.trim());
  }
  return entry.type === 'remote' && validOpenCodeUrl(entry.url);
}
function validOpenCodeUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const reference = /\{(?:env|file):[^{}\r\n]+\}/g;
  const tokens = value.match(reference);
  if (tokens?.length === 1 && tokens[0] === value) return true;
  if (unsupportedLiteralProtocol(value, reference)) return false;
  const masked = value.replace(reference, (token: string, offset: number) => {
    if (offset !== 0) return '1';
    // A leading reference can supply the scheme or the whole base URL.
    return value.slice(token.length).startsWith(':')
      ? 'https'
      : 'https://placeholder.invalid';
  });
  return url(masked) !== null;
}
function unsupportedLiteralProtocol(value: string, reference: RegExp) {
  // WHATWG parsing ignores tabs/newlines; placeholders must not hide a literal scheme.
  const normalized = value.replace(/[\t\r\n]/g, '').trimStart();
  const literal = normalized.replace(reference, '');
  const hostPort = /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(
    normalized.replace(reference, '1'),
  );
  return (
    !hostPort &&
    /^[a-z][a-z\d+.-]*:/i.test(literal) &&
    !/^https?:/i.test(literal)
  );
}
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parseDocument(
  text: string,
  format: 'json' | 'jsonc' | 'toml',
): Record<string, unknown> {
  let value: unknown;
  if (format === 'toml') value = parseToml(text);
  else if (format === 'json') value = JSON.parse(text);
  else {
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length || !tree) throw new Error('Invalid JSONC.');
    // AST materialization uses null-prototype objects, preserving literal
    // property names such as __proto__ without invoking inherited setters.
    value = getNodeValue(tree);
  }
  const result = object(value);
  if (!result) throw new Error('Expected an object.');
  return result;
}
const label = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9 ._-]{0,99}$/i.test(value)
    ? value
    : fallback;
const url = (value: unknown): URL | null => {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /\{(?:env|file):/.test(value)
  )
    return null;
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
};
function countBindings(entry: Record<string, unknown>): number {
  const secretArray = Array.isArray(entry.secrets) ? entry.secrets.length : 0;
  const headerObject =
    object(entry.headers) ??
    object(entry.http_headers) ??
    object(object(entry.remote)?.headers);
  // Count declarations only: never inspect/return values or guess their storage.
  return Math.min(
    256,
    Math.max(secretArray, headerObject ? Object.keys(headerObject).length : 0),
  );
}
export interface PrivateCandidate {
  public: AdoptionCandidate;
  key: string;
  endpoint: string | null;
  image: string | null;
  command: string[] | null;
  credentialUrl: boolean;
}
function candidate(
  name: unknown,
  entry: Record<string, unknown>,
  index: number,
  mode: AdoptionCandidate['executionMode'],
): PrivateCandidate {
  const remote = object(entry.remote);
  const endpoint = url(entry.url ?? remote?.url ?? entry.endpoint);
  const displayName = label(name, `Observed connector ${index + 1}`);
  return {
    public: {
      id: `observed-${index}-${hash(displayName).slice(0, 12)}`,
      name: displayName,
      executionMode: mode,
      origin: endpoint?.origin ?? null,
      secretBindingCount: countBindings(entry),
      verification: 'not_performed',
    },
    key: typeof name === 'string' ? name.toLowerCase() : `unknown-${index}`,
    // Private comparison data is short-lived and never part of a DTO/log/file.
    endpoint: endpoint ? endpoint.origin + endpoint.pathname : null,
    image: typeof entry.image === 'string' ? entry.image : null,
    command:
      strings(entry.command) ??
      (typeof entry.command === 'string'
        ? [entry.command, ...(strings(entry.args) ?? [])]
        : null),
    credentialUrl: !!(
      endpoint?.username ||
      endpoint?.password ||
      endpoint?.search ||
      endpoint?.hash
    ),
  };
}
export function inspectDockerProfile(
  text: string,
  profileId: string,
): { candidates: PrivateCandidate[]; fingerprint: string } {
  const document = parseDocument(text, 'json');
  if (
    document.version !== 1 ||
    document.id !== profileId ||
    !Array.isArray(document.servers) ||
    document.servers.length > 63
  )
    throw new Error('Unsupported profile snapshot.');
  const candidates = document.servers.map((raw, index) => {
    const entry = object(raw);
    const server = object(object(entry?.snapshot)?.server);
    if (!entry || !server || !['remote', 'image'].includes(String(entry.type)))
      throw new Error('Unsupported profile entry.');
    if (
      entry.type === 'remote' &&
      !url(object(server.remote)?.url ?? entry.endpoint)
    )
      throw new Error('Malformed remote snapshot.');
    if (entry.type === 'image' && typeof server.image !== 'string')
      throw new Error('Malformed image snapshot.');
    return candidate(
      server.name,
      { ...server, endpoint: entry.endpoint },
      index,
      entry.type === 'remote' ? 'remote' : 'docker',
    );
  });
  return { candidates, fingerprint: hash(document) };
}
export function inspectSource(text: string): PrivateCandidate[] {
  const document = parseDocument(text, 'jsonc');
  const maps = [
    object(document.mcpServers),
    object(document.servers),
    object(object(document.mcp)?.servers),
  ].filter((value) => value !== null);
  if (!maps.length) throw new Error('Unsupported source wrappers.');
  const entries = maps.flatMap((map) => Object.entries(map));
  if (entries.length > 256) throw new Error('Source inventory is oversized.');
  const result: PrivateCandidate[] = [];
  for (const [name, value] of entries) {
    const entry = object(value);
    if (!entry) throw new Error('Invalid source entry.');
    const mode = url(entry.url ?? object(entry.remote)?.url)
      ? 'remote'
      : typeof entry.image === 'string'
        ? 'docker'
        : 'native';
    result.push(candidate(name, entry, result.length, mode));
  }
  return result;
}
export function compareSnapshots(
  profile: PrivateCandidate[],
  source: PrivateCandidate[],
): { drift: DiscoverySnapshot['pilot']['drift']; unmatched: number } {
  const matched = new Set<PrivateCandidate>();
  let different = false;
  let unknown = false;
  for (const entry of profile) {
    const byName = source.filter((item) => item.key === entry.key);
    const byEndpoint = entry.endpoint
      ? source.filter((item) => item.endpoint === entry.endpoint)
      : [];
    const options = byName.length ? byName : byEndpoint;
    if (!options.length) {
      unknown = true;
      continue;
    }
    for (const match of options) {
      matched.add(match);
      if (entry.public.executionMode !== match.public.executionMode) {
        unknown = true;
        continue;
      }
      if (entry.endpoint !== match.endpoint || entry.image !== match.image)
        different = true;
      if (entry.credentialUrl || match.credentialUrl) unknown = true;
      if (entry.public.executionMode === 'docker') {
        if (entry.command && match.command) {
          if (hash(entry.command) !== hash(match.command)) different = true;
        } else if (entry.command !== match.command) unknown = true;
      }
    }
  }
  return {
    drift: different
      ? 'different'
      : unknown || !profile.length
        ? 'unknown'
        : 'matching',
    unmatched: source.length - matched.size,
  };
}

function pointer(
  entry: Record<string, unknown>,
  profileId: string,
  chromeLauncher: string,
): 'gateway' | 'chrome' | 'conflict' | null {
  const array = strings(entry.command);
  const args = array ? array.slice(1) : (strings(entry.args) ?? []);
  const command =
    array?.[0] ?? (typeof entry.command === 'string' ? entry.command : '');
  const binary = win32.basename(command).toLowerCase();
  const profileIndex = args.findIndex((arg) => arg === '--profile');
  if (
    ['docker', 'docker.exe'].includes(binary) &&
    args.slice(0, 3).join(' ') === 'mcp gateway run'
  )
    return args[profileIndex + 1] === profileId &&
      profileIndex >= 0 &&
      args.filter((arg) => arg === '--profile').length === 1 &&
      !args.some((arg) => arg.startsWith('--profile='))
      ? 'gateway'
      : 'conflict';
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(binary)) {
    const index = args.findIndex((arg) => arg.toLowerCase() === '-file');
    if (
      index >= 0 &&
      args[index + 1] &&
      win32.normalize(args[index + 1]!).toLowerCase() ===
        win32.normalize(chromeLauncher).toLowerCase()
    )
      return 'chrome';
    const gatewayLauncher = win32.join(
      win32.dirname(chromeLauncher),
      'Start-Pilot.ps1',
    );
    if (
      index >= 0 &&
      args[index + 1] &&
      win32.normalize(args[index + 1]!).toLowerCase() ===
        win32.normalize(gatewayLauncher).toLowerCase()
    )
      return 'gateway';
  }
  return null;
}
export function inspectAgentFile(
  path: string,
  read: ReadResult,
  format: 'jsonc' | 'toml',
  shape: 'opencode' | 'codex' | 'mcpServers' | 'policy',
  profileId: string,
  chromeLauncher: string,
): FileObservation {
  const observation: FileObservation = {
    path,
    status: read.status,
    fingerprint: read.status === 'read' ? read.fingerprint : null,
    hubEntries: [],
    binding: 'unknown',
    entryCount: null,
  };
  if (read.status !== 'read') return observation;
  try {
    const document = parseDocument(read.text, format);
    if (shape === 'policy') {
      observation.entryCount = 0;
      observation.binding = 'absent';
      return observation;
    }
    if (shape === 'opencode') {
      if (document.mcp !== undefined && !object(document.mcp))
        throw new Error('Malformed MCP object.');
      if (document.mcpServers !== undefined) {
        observation.status = 'unsupported';
        return observation;
      }
    }
    const rawMap =
      shape === 'opencode'
        ? document.mcp === undefined
          ? undefined
          : openCodeServers(document.mcp)
        : shape === 'codex'
          ? document.mcp_servers
          : document.mcpServers;
    if (rawMap !== undefined && !object(rawMap))
      throw new Error('Invalid MCP configuration.');
    const map = object(rawMap) ?? {};
    const entries = Object.entries(map);
    if (entries.length > 256) throw new Error('Oversized config.');
    observation.entryCount = entries.length;
    let conflict = false;
    for (const [name, value] of entries) {
      const entry = object(value);
      if (!entry) throw new Error('Invalid MCP entry.');
      if (shape === 'opencode' && !validOpenCodeEntry(entry))
        throw new Error('Invalid OpenCode MCP entry.');
      const match = pointer(entry, profileId, chromeLauncher);
      const expected =
        name === 'hub-pilot'
          ? 'gateway'
          : name === 'hub-chrome'
            ? 'chrome'
            : null;
      if (expected && match !== expected) conflict = true;
      if (match === 'gateway' || match === 'chrome') {
        if (entry.disabled === true || entry.enabled === false) conflict = true;
        if (!observation.hubEntries.includes(match))
          observation.hubEntries.push(match);
      }
    }
    observation.binding = conflict
      ? 'conflict'
      : observation.hubEntries.length === 2
        ? 'matching'
        : observation.hubEntries.length
          ? 'unknown'
          : 'absent';
  } catch {
    observation.status = 'invalid';
    observation.binding = 'unknown';
    observation.entryCount = null;
    observation.hubEntries = [];
  }
  return observation;
}
