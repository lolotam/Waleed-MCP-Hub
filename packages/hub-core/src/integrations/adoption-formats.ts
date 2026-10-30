import { applyEdits, modify } from 'jsonc-parser';
import {
  parseForESLint,
  getStaticTOMLValue,
  type AST,
} from 'toml-eslint-parser';
import { object } from '../discovery/metadata.js';
import { hashData } from '../runtime/registry.js';
import { HubError } from '../errors.js';
import {
  managedName,
  parseAgentDocument,
  type AgentFormat,
  agentServerMapPath,
} from './formats.js';

const fail = () =>
  new HubError(
    'invalid',
    'Agent import is malformed, ambiguous, or uses an unsupported server layout.',
  );
export const serverMapPath = agentServerMapPath;
function mapOf(doc: Record<string, unknown>, format: AgentFormat) {
  let current: unknown = doc;
  for (const key of serverMapPath(format, doc))
    current = object(current)?.[key];
  if (current === undefined) return {};
  const map = object(current);
  if (!map) throw fail();
  return map;
}
export function readAgentServers(text: string, format: AgentFormat) {
  if (format === 'goose') throw fail(); // YAML integration is supported; protected adoption is a separate unsupported adapter.
  const doc = parseAgentDocument(text.replace(/^\uFEFF/, ''), format),
    map = mapOf(doc, format);
  const keys = Object.keys(map)
    .filter((key) => key !== managedName)
    .sort();
  if (!keys.length || keys.length > 32) throw fail();
  const servers: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const value = object(map[key]);
    if (!value) throw fail();
    const entry = { ...value };
    if (format === 'codex' && Object.hasOwn(entry, 'http_headers')) {
      if (Object.hasOwn(entry, 'headers')) throw fail();
      entry.headers = entry.http_headers;
      delete entry.http_headers;
    }
    servers[key] = entry;
  }
  return { source: JSON.stringify({ mcpServers: servers }), keys };
}
// Remove only selected AST nodes. Compare all remaining semantics afterwards;
// unsupported TOML layouts fail rather than serialize away comments/settings.
export function removeAgentServers(
  text: string,
  format: AgentFormat,
  names: string[],
) {
  if (format === 'goose') throw fail();
  const before = parseAgentDocument(text.replace(/^\uFEFF/, ''), format),
    map = mapOf(before, format);
  if (names.some((name) => name === managedName || !Object.hasOwn(map, name)))
    throw fail();
  let result = text;
  if (format !== 'codex') {
    for (const name of names)
      result = applyEdits(
        result,
        modify(result, [...serverMapPath(format, before), name], undefined, {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: text.includes('\r\n') ? '\r\n' : '\n',
          },
        }),
      );
  } else {
    const ast = parseForESLint(text, { tomlVersion: '1.0' }).ast;
    const ranges: Array<[number, number]> = [];
    const inlineRemovals = new Map<
      AST.TOMLInlineTable,
      Set<AST.TOMLKeyValue>
    >();
    const selected = (path: string[]) =>
      path[0] === 'mcp_servers' && names.includes(path[1] ?? '');
    const walk = (entry: AST.TOMLKeyValue, base: string[]) => {
      const path = [...base, ...getStaticTOMLValue(entry.key)];
      if (selected(path)) {
        if (entry.parent.type === 'TOMLInlineTable') {
          const selected =
            inlineRemovals.get(entry.parent) ?? new Set<AST.TOMLKeyValue>();
          selected.add(entry);
          inlineRemovals.set(entry.parent, selected);
        } else ranges.push(entry.range);
        return;
      }
      if (entry.value.type === 'TOMLInlineTable')
        for (const child of entry.value.body) walk(child, path);
    };
    for (const entry of ast.body[0].body) {
      if (entry.type === 'TOMLTable') {
        const path = entry.resolvedKey.map(String);
        if (selected(path)) ranges.push(entry.range);
        else for (const value of entry.body) walk(value, path);
      } else walk(entry, []);
    }
    for (const [parent, selected] of inlineRemovals)
      for (let start = 0; start < parent.body.length; start++) {
        if (!selected.has(parent.body[start]!)) continue;
        let finish = start;
        while (selected.has(parent.body[finish + 1]!)) finish++;
        const previous = parent.body[start - 1],
          next = parent.body[finish + 1];
        ranges.push(
          next
            ? [parent.body[start]!.range[0], next.range[0]]
            : previous
              ? [previous.range[1], parent.body[finish]!.range[1]]
              : [parent.body[start]!.range[0], parent.body[finish]!.range[1]],
        );
        start = finish;
      }
    const merged: Array<[number, number]> = [];
    for (const range of ranges.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    for (const [start, end] of merged.reverse())
      result = result.slice(0, start) + result.slice(end);
  }
  for (const name of names) delete map[name];
  const after = parseAgentDocument(result.replace(/^\uFEFF/, ''), format);
  // Empty newly-created/deleted wrapper maps carry no settings.
  const clean = (doc: Record<string, unknown>) => {
    const path = serverMapPath(format, doc);
    for (let i = path.length - 1; i >= 0; i--) {
      let owner = doc;
      for (const key of path.slice(0, i)) owner = object(owner[key]) ?? {};
      const key = path[i]!;
      if (object(owner[key]) && !Object.keys(owner[key] as object).length)
        delete owner[key];
    }
    return doc;
  };
  if (hashData(clean(before)) !== hashData(clean(after))) throw fail();
  return result;
}
