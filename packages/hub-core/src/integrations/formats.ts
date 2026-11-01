import { applyEdits, modify, parseTree, type Node } from 'jsonc-parser';
import { parseDocument, object } from '../discovery/metadata.js';
import { hashData } from '../runtime/registry.js';
import { HubError } from '../errors.js';

export const managedName = 'waleed-mcp-hub';
export type AgentFormat =
  'opencode' | 'codex' | 'mcpServers' | 'vscode' | 'kilo';
const pathFor = (format: AgentFormat) =>
  format === 'opencode'
    ? ['mcp', 'servers', managedName]
    : [
        format === 'codex'
          ? 'mcp_servers'
          : format === 'vscode'
            ? 'servers'
            : format === 'kilo'
              ? 'mcp'
              : 'mcpServers',
        managedName,
      ];
const conflict = () =>
  new HubError(
    'conflict',
    'Agent configuration is invalid, ambiguous or contains a conflicting managed entry.',
  );
function document(text: string, format: AgentFormat) {
  if (format !== 'codex') {
    const walk = (node: Node) => {
      if (node.type === 'object') {
        const keys =
          node.children?.map(
            (property) => property.children?.[0]?.value as unknown,
          ) ?? [];
        if (new Set(keys).size !== keys.length) throw conflict();
      }
      for (const child of node.children ?? []) walk(child);
    };
    const tree = parseTree(text);
    if (!tree) throw conflict();
    walk(tree);
  }
  try {
    return parseDocument(text, format === 'codex' ? 'toml' : 'jsonc');
  } catch {
    throw conflict();
  }
}
export function managedEntry(
  text: string | null,
  format: AgentFormat,
): unknown {
  if (text === null) return undefined;
  let value: unknown = document(text.replace(/^\uFEFF/, ''), format);
  for (const key of pathFor(format)) {
    if (!object(value)) throw conflict();
    value = (value as Record<string, unknown>)[key];
    if (value === undefined) return undefined;
  }
  return value;
}

// Source MCP extraction shares the strict parser used for owned edits. No
// project search, executable config or credential-cache loading occurs here.
export function agentServers(
  text: string,
  format: AgentFormat,
): Record<string, unknown> {
  const root = document(text.replace(/^\uFEFF/, ''), format);
  const mcp = object(root.mcp);
  const nestedServers = object(mcp?.servers);
  // A direct server named "servers" must not hide its siblings. The optional
  // wrapper contains server records, rather than a server's own fields.
  const wrappedServers =
    nestedServers &&
    Object.keys(mcp!).length === 1 &&
    Object.values(nestedServers).every((value) => object(value));
  const map =
    format === 'codex'
      ? root.mcp_servers
      : format === 'vscode'
        ? root.servers
        : format === 'opencode'
          ? wrappedServers
            ? nestedServers
            : root.mcp
          : format === 'kilo'
            ? root.mcp
            : root.mcpServers;
  if (map === undefined) return {};
  const result = object(map);
  if (!result) throw conflict();
  return result;
}
export function agentEntry(
  format: AgentFormat,
  node: string,
  bridge: string,
  registry: string,
  agentId: string,
) {
  const args = [bridge, registry, agentId];
  if (format === 'opencode') return { type: 'local', command: [node, ...args] };
  if (format === 'kilo')
    return { type: 'local', command: [node, ...args], enabled: true };
  return {
    ...(format === 'vscode' || format === 'mcpServers'
      ? { type: 'stdio' }
      : {}),
    command: node,
    args,
  };
}
const begin = '# WMH BEGIN waleed-mcp-hub';
const end = '# WMH END waleed-mcp-hub';
export function editAgentDocument(
  text: string | null,
  format: AgentFormat,
  entry: Record<string, unknown> | undefined,
  expectedEntryHash?: string,
) {
  const current = managedEntry(text, format);
  if (
    current !== undefined &&
    (!expectedEntryHash || hashData(current) !== expectedEntryHash)
  )
    throw conflict();
  const raw = text ?? (format === 'codex' ? '' : '{}\n');
  let result: string;
  if (format === 'codex') {
    const start = raw.indexOf(begin),
      finish = raw.indexOf(end);
    if (
      (current !== undefined && (start < 0 || finish < start)) ||
      (current === undefined && (start >= 0 || finish >= 0))
    )
      throw conflict();
    const clean =
      start < 0
        ? raw
        : raw.slice(0, start) +
          raw.slice(finish + end.length).replace(/^\r?\n/, '');
    if (entry === undefined) result = clean;
    else {
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      result =
        clean +
        (clean.endsWith('\n') || !clean ? '' : eol) +
        [
          begin,
          `[mcp_servers.${managedName}]`,
          `command = ${JSON.stringify(entry.command)}`,
          `args = ${JSON.stringify(entry.args)}`,
          'startup_timeout_sec = 30',
          end,
          '',
        ].join(eol);
    }
  } else {
    result = applyEdits(
      raw,
      modify(raw, pathFor(format), entry, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: raw.includes('\r\n') ? '\r\n' : '\n',
        },
      }),
    );
  }
  const actual = managedEntry(result, format);
  if (
    entry === undefined
      ? actual !== undefined
      : hashData(actual) !==
        hashData(
          format === 'codex' ? { ...entry, startup_timeout_sec: 30 } : entry,
        )
  )
    throw conflict();
  // Verify semantics outside the owned entry instead of trusting an edit library.
  const without = (value: string) => {
    const doc = document(value.replace(/^\uFEFF/, ''), format);
    const path = pathFor(format);
    let parent = doc;
    for (const key of path.slice(0, -1)) {
      const next = object(parent[key]);
      if (!next) return doc;
      parent = next;
    }
    delete parent[managedName];
    // New empty parent maps are allowed, never remove existing nonempty maps.
    for (let depth = path.length - 2; depth >= 0; depth--) {
      let owner = doc;
      for (const key of path.slice(0, depth)) owner = object(owner[key])!;
      const key = path[depth]!;
      const child = object(owner[key]);
      if (child && !Object.keys(child).length) delete owner[key];
    }
    return doc;
  };
  if (hashData(without(raw)) !== hashData(without(result))) throw conflict();
  return result;
}
