import { PackageProvenanceSchema } from '@waleed/contracts';
import { PackageFault } from './fault.js';

// One procedure for the registry metadata and for the installed package.json:
// a string bin becomes a single entry named after the package (without its
// scope), an object bin is used as it is, and every unsupported or ambiguous
// shape fails with `no_entry`.
export interface NormalizedBin {
  entry: string;
  entryPath: string;
}

// The preview offers at most this many entry candidates.
const MAX_ENTRIES = 64;
const noEntry = () => new PackageFault('no_entry');

// A bin path is relative to the package folder: "/" separators, no drive, no
// UNC prefix, no empty, "." or ".." segment and nothing that Windows would
// silently rewrite.
const normalizeEntryPath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) throw noEntry();
  let path = value.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (/^[A-Za-z]:/.test(path)) throw noEntry();
  if (path.startsWith('/')) throw noEntry();
  if (path.includes('//')) throw noEntry();
  for (const segment of path.split('/'))
    if (segment === '' || segment === '.' || segment === '..') throw noEntry();
  if (!PackageProvenanceSchema.shape.entryPath.safeParse(path).success)
    throw noEntry();
  return path;
};

// The package name without its scope: "@scope/tool" offers "tool".
const unscoped = (packageName: string): string => {
  const slash = packageName.lastIndexOf('/');
  return slash === -1 ? packageName : packageName.slice(slash + 1);
};

export function normalizeBin(
  packageName: string,
  bin: unknown,
): NormalizedBin[] {
  const candidates = new Map<string, unknown>();
  if (typeof bin === 'string') {
    candidates.set(unscoped(packageName), bin);
  } else if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    for (const [name, path] of Object.entries(bin as Record<string, unknown>))
      candidates.set(name, path);
  } else throw noEntry();
  if (candidates.size === 0) throw noEntry();
  if (candidates.size > MAX_ENTRIES) throw noEntry();
  const entries: NormalizedBin[] = [];
  for (const [name, path] of candidates) {
    if (!PackageProvenanceSchema.shape.entry.safeParse(name).success)
      throw noEntry();
    entries.push({ entry: name, entryPath: normalizeEntryPath(path) });
  }
  entries.sort((left, right) => (left.entry < right.entry ? -1 : 1));
  return entries;
}
