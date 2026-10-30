import {
  parseAllDocuments,
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  isAlias,
  stringify,
  type YAMLMap,
} from 'yaml';
import { HubError } from '../errors.js';
import { hashData } from '../runtime/registry.js';
const fail = () =>
  new HubError(
    'conflict',
    'Goose YAML is invalid, ambiguous or outside the supported lossless mapping subset.',
  );
export function gooseDocument(text: string) {
  if (Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0'))
    throw fail();
  const docs = parseAllDocuments(text, {
    keepSourceTokens: true,
    uniqueKeys: true,
    strict: true,
    version: '1.2',
  });
  if (docs.length > 1 || /^\s*\.\.\.(?:\s|$)/m.test(text)) throw fail();
  const doc = docs[0] ?? parseDocument(text);
  if (doc.errors.length || doc.warnings.length) throw fail();
  let count = 0;
  const walk = (node: unknown, depth = 0) => {
    if (++count > 65536 || depth > 32) throw fail();
    if (!node) return;
    if (
      isAlias(node) ||
      ((isMap(node) || isSeq(node) || isScalar(node)) &&
        (node.anchor || node.tag))
    )
      throw fail();
    if (isMap(node))
      for (const item of node.items) {
        if (
          !isScalar(item.key) ||
          typeof item.key.value !== 'string' ||
          item.key.anchor ||
          item.key.tag ||
          ['__proto__', 'prototype', 'constructor', '<<'].includes(
            item.key.value,
          )
        )
          throw fail();
        walk(item.value, depth + 1);
      }
    else if (isSeq(node)) for (const item of node.items) walk(item, depth + 1);
    else if (
      isScalar(node) &&
      typeof node.value === 'number' &&
      !Number.isFinite(node.value)
    )
      throw fail();
  };
  walk(doc.contents);
  if (doc.contents !== null && !isMap(doc.contents)) throw fail();
  const value = (doc.toJS({ maxAliasCount: 0 }) ?? {}) as Record<
    string,
    unknown
  >;
  return { doc, value };
}
const lineStart = (raw: string, offset: number) =>
  raw.lastIndexOf('\n', offset - 1) + 1;
export function editGooseEntry(
  raw: string,
  name: string,
  entry: Record<string, unknown> | undefined,
  expectedEntryHash?: string,
) {
  const { doc, value } = gooseDocument(raw),
    root = doc.contents;
  if (root && (!isMap(root) || root.flow)) throw fail();
  const pair = isMap(root)
    ? root.items.find(
        (item) => isScalar(item.key) && item.key.value === 'extensions',
      )
    : undefined;
  const map = pair?.value;
  if (pair && (!isMap(map) || (map.flow && map.items.length > 0))) throw fail();
  const current = isMap(map) ? map.get(name, true) : undefined;
  if (
    current !== undefined &&
    (!expectedEntryHash ||
      hashData((value.extensions as Record<string, unknown>)?.[name]) !==
        expectedEntryHash)
  )
    throw fail();
  if (!entry && current === undefined) return raw;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const block = (indent: number) =>
    stringify({ [name]: entry }, { indent: 2, lineWidth: 0 })
      .trimEnd()
      .split('\n')
      .map((line) => ' '.repeat(indent) + line)
      .join(eol) + eol;
  let result: string;
  if (!pair) {
    if (!entry) return raw;
    const prefix = raw.trim() ? raw + (raw.endsWith('\n') ? '' : eol) : raw;
    result = prefix + 'extensions:' + eol + block(2);
  } else if (isMap(map) && map.flow) {
    if (!entry || !map.range) throw fail();
    // Replace only the empty owned parent token; retain all surrounding bytes.
    const newline = raw.indexOf('\n', map.range[1]),
      end = newline < 0 ? raw.length : newline + 1;
    const tail = raw.slice(map.range[1], end).replace(/\r?\n$/, '');
    result =
      raw.slice(0, map.range[0]) + tail + eol + block(2) + raw.slice(end);
  } else {
    const parent = map as YAMLMap;
    const existing = parent.items.find(
      (item) => isScalar(item.key) && item.key.value === name,
    );
    const first = parent.items[0];
    if (!first || !isScalar(first.key) || !first.key.range) throw fail();
    const firstStart = lineStart(raw, first.key.range[0]),
      indent = first.key.range[0] - firstStart;
    if (indent < 1 || !/^[ ]*$/.test(raw.slice(firstStart, first.key.range[0])))
      throw fail();
    if (existing) {
      if (
        !isScalar(existing.key) ||
        !existing.key.range ||
        !isMap(existing.value) ||
        !existing.value.range
      )
        throw fail();
      const start = lineStart(raw, existing.key.range[0]),
        end = existing.value.range[2];
      // An owned node must occupy whole block lines, not a partial scalar/flow pair.
      if (
        raw.slice(start, existing.key.range[0]) !== ' '.repeat(indent) ||
        (end < raw.length && raw[end - 1] !== '\n')
      )
        throw fail();
      result =
        raw.slice(0, start) + (entry ? block(indent) : '') + raw.slice(end);
      if (!entry && parent.items.length === 1) {
        const key = pair.key;
        if (!isScalar(key) || !key.range) throw fail();
        const headerEnd = raw.indexOf('\n', key.range[0]),
          header = raw.slice(
            key.range[0],
            headerEnd < 0 ? raw.length : headerEnd,
          ),
          colon = header.indexOf(':');
        if (colon < 0) throw fail();
        const position = key.range[0] + colon + 1;
        result = result.slice(0, position) + ' {}' + result.slice(position);
      }
    } else
      result = raw.slice(0, firstStart) + block(indent) + raw.slice(firstStart);
  }
  const actual = gooseDocument(result).value;
  const newEntry = (actual.extensions as Record<string, unknown> | undefined)?.[
    name
  ];
  if (entry ? hashData(newEntry) !== hashData(entry) : newEntry !== undefined)
    throw fail();
  const without = (input: Record<string, unknown>) => {
    const value = structuredClone(input),
      extensions = value.extensions as Record<string, unknown> | undefined;
    if (extensions) {
      delete extensions[name];
      if (!Object.keys(extensions).length) delete value.extensions;
    }
    return value;
  };
  if (hashData(without(value)) !== hashData(without(actual))) throw fail();
  return result;
}
