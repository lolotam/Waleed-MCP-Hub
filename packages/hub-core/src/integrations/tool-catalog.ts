import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { assertNoLinks } from '../adapters/managed-files.js';

// The last tools a connector listed, under the definition that listed them.
// A cached entry is only advertised while its connector still has that
// definition and its approval; calls always go through the full startup.
export interface CatalogEntry {
  hash: string;
  tools: Tool[];
}
export type ToolCatalog = Map<string, CatalogEntry>;
export interface ToolCatalogStore {
  read(): Promise<ToolCatalog | undefined>;
  write(catalog: ToolCatalog): Promise<void>;
}

const maxTools = 256;

// An unreadable, oversized or malformed catalog is no catalog: the bridge
// then discovers as if it had never listed.
export function parseToolCatalog(text: string): ToolCatalog | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { version?: unknown }).version !== 1 ||
    !Array.isArray((raw as { connectors?: unknown }).connectors)
  )
    return undefined;
  const catalog: ToolCatalog = new Map();
  let count = 0;
  for (const item of (raw as { connectors: unknown[] }).connectors) {
    const { id, hash, tools } = (item ?? {}) as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !Array.isArray(tools) ||
      catalog.has(id)
    )
      return undefined;
    count += tools.length;
    if (count > maxTools) return undefined;
    const parsed: Tool[] = [];
    for (const tool of tools) {
      const checked = ToolSchema.safeParse(tool);
      if (!checked.success) return undefined;
      parsed.push(checked.data);
    }
    catalog.set(id, { hash, tools: parsed });
  }
  return catalog;
}

export function serializeToolCatalog(catalog: ToolCatalog) {
  return JSON.stringify({
    version: 1,
    connectors: [...catalog].map(([id, entry]) => ({ id, ...entry })),
  });
}

// Replaces the catalog file atomically, readable by the current user only.
export async function writeToolCatalogFile(path: string, catalog: ToolCatalog) {
  await assertNoLinks(path, true);
  const temporary = join(dirname(path), `.tool-catalog-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(serializeToolCatalog(catalog));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
