import { applyEdits, modify, parseTree, type Node } from 'jsonc-parser';
import { parseDocument, object } from '../discovery/metadata.js';
import { hashData } from '../runtime/registry.js';
import { HubError } from '../errors.js';
import { gooseDocument, editGooseEntry } from './goose-yaml.js';

export const managedName = 'waleed-mcp-hub';
export type AgentFormat =
  'opencode' | 'codex' | 'mcpServers' | 'vscode' | 'kilo' | 'zed' | 'goose';
export const agentServerMapPath = (
  format: AgentFormat,
  doc?: Record<string, unknown>,
) =>
  format === 'opencode'
    ? ['mcp', 'servers']
    : [
        format === 'goose'
          ? 'extensions'
          : format === 'zed'
            ? doc && Object.hasOwn(doc, 'mcpServers')
              ? 'mcpServers'
              : 'context_servers'
            : format === 'codex'
              ? 'mcp_servers'
              : format === 'vscode'
                ? 'servers'
                : format === 'kilo'
                  ? 'mcp'
                  : 'mcpServers',
      ];
const pathFor = (format: AgentFormat, doc?: Record<string, unknown>) => [
  ...agentServerMapPath(format, doc),
  managedName,
];
const conflict = () =>
  new HubError(
    'conflict',
    'Agent configuration is invalid, ambiguous or contains a conflicting managed entry.',
  );
export function parseAgentDocument(text: string, format: AgentFormat) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw conflict();
  if (format === 'goose') return gooseDocument(text).value;
  if (format !== 'codex') {
    let count = 0;
    const walk = (node: Node, depth = 0) => {
      if (++count > 65536 || depth > 32) throw conflict();
      if (node.type === 'object') {
        const keys =
          node.children?.map(
            (property) => property.children?.[0]?.value as unknown,
          ) ?? [];
        if (
          new Set(keys).size !== keys.length ||
          keys.some((key) =>
            ['__proto__', 'prototype', 'constructor'].includes(String(key)),
          )
        )
          throw conflict();
      }
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    const tree = parseTree(text);
    if (!tree) throw conflict();
    walk(tree);
  }
  try {
    const doc = parseDocument(text, format === 'codex' ? 'toml' : 'jsonc');
    if (
      format === 'zed' &&
      Object.hasOwn(doc, 'context_servers') &&
      Object.hasOwn(doc, 'mcpServers')
    )
      throw conflict();
    return doc;
  } catch {
    throw conflict();
  }
}
const document = parseAgentDocument;
export function managedEntry(
  text: string | null,
  format: AgentFormat,
): unknown {
  if (text === null) return undefined;
  let value: unknown = document(text.replace(/^\uFEFF/, ''), format);
  for (const key of pathFor(format, object(value) ?? undefined)) {
    if (!object(value)) throw conflict();
    value = (value as Record<string, unknown>)[key];
    if (value === undefined) return undefined;
  }
  return value;
}
export function agentEntry(
  format: AgentFormat,
  node: string,
  bridge: string,
  registry: string,
  agentId: string,
) {
  const args = [bridge, registry, agentId];
  if (format === 'goose')
    return {
      type: 'stdio',
      name: managedName,
      enabled: true,
      cmd: node,
      args,
      envs: {},
      env_keys: [],
      timeout: 300,
    };
  if (format === 'zed') return { command: node, args, env: {} };
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
  const raw = text ?? (format === 'codex' || format === 'goose' ? '' : '{}\n');
  if (format === 'goose')
    return editGooseEntry(raw, managedName, entry, expectedEntryHash);
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
      modify(
        raw,
        pathFor(format, document(raw.replace(/^\uFEFF/, ''), format)),
        entry,
        {},
      ),
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
    const path = pathFor(format, doc);
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
