import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  PackagePreview,
  PackageResolveRequest,
  PackageWarning,
} from '@waleed/contracts';
import { PackageProvenanceSchema } from '@waleed/contracts';
import type { ProcessRunner } from '../ports.js';
import { PackageFault } from './fault.js';
import { normalizeBin } from './entry.js';
import { createRegistryFetcher, registryPath } from './fetch.js';
import {
  DEFAULT_REGISTRY,
  assertNoAncestorProject,
  npmFault,
  prepareJob,
  runNpm,
  type RegistryTarget,
} from './npm.js';
import { PREVIEW_TTL_MS, type PreviewStore } from './previews.js';
import { jobDirectory, readOwnedFile, removeTree } from './store.js';
import {
  WATCHDOG_MAX_BYTES,
  WATCHDOG_MAX_FILES,
  freeBytes,
  withWatchdog,
} from './watchdog.js';

// The semver and the spec parser of the bundled npm: the hub never depends on
// copies of its own, so the pinned npm is the only source of the spec rules.
const npmRequire = createRequire(import.meta.url);
const bundledRequire = createRequire(npmRequire.resolve('npm/package.json'));
interface SemverModule {
  satisfies(version: string, range: string): boolean;
  validRange(range: string): string | null;
  maxSatisfying(versions: string[], range: string): string | null;
}
interface NpaModule {
  resolve(name: string, spec: string): { type: string };
}
const semver = bundledRequire('semver') as SemverModule;
const npa = bundledRequire('npm-package-arg') as NpaModule;
const REGISTRY_SPEC_TYPES = new Set(['range', 'version', 'tag']);

const MAX_ABBREVIATED_BYTES = 8 * 1024 * 1024;
const MAX_VERSION_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_FULL_PACKUMENT_BYTES = 32 * 1024 * 1024;
// The cap of the frozen lock. The install writes the very same bytes, so it
// caps them the same way.
export const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_FILE_COUNT = 50_000;
// The number of installed packages of one tree. A wider tree is refused
// before a single version document is fetched.
const MAX_PACKAGE_COUNT = 2000;
const WARNING_UNPACKED_BYTES = 200 * 1024 * 1024;
const WARNING_PACKAGE_COUNT = 300;
const RECENT_RELEASE_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_CAP_BYTES = 300 * 1024 * 1024;
const NPM_TIMEOUT_MS = 600_000;
const PARALLEL_LIMIT = 8;

// The dependency fields the hub reads from a version document. Every spec in
// them has to be a registry range or a tag.
const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
// The warning order is the order of the contract.
const WARNING_ORDER: readonly PackageWarning[] = [
  'install_scripts',
  'install_scripts_unknown',
  'optional_omitted',
  'recent_release',
  'release_date_unknown',
  'deprecated',
  'engine_mismatch',
  'many_packages',
  'large_size',
  'size_unknown',
];
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const exactVersion = PackageProvenanceSchema.shape.version;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

// A dependency spec is acceptable only when it names a registry release: a
// semver range or a dist-tag. A file, a link, a workspace, an alias, a git
// reference, an URL and a path are all refused. npm's own parser decides,
// because a tag-shaped spec such as "tool.tgz" is a file to npm.
export const isRegistrySpec = (spec: string): boolean => {
  if (typeof spec !== 'string') return false;
  // An empty range is the range "*": npm reads it as every release of the
  // registry, so it is a registry range and not a file.
  if (spec.length > 256) return false;
  let type: string;
  try {
    type = npa.resolve('placeholder', spec).type;
  } catch {
    return false;
  }
  if (!REGISTRY_SPEC_TYPES.has(type)) return false;
  return type !== 'tag' || DIST_TAG.test(spec);
};

// The name behind a lock key: "node_modules/a/node_modules/@scope/b" is
// "@scope/b". Anything that is not a chain of node_modules folders is refused.
const lockName = (key: string): string | null => {
  const segments = key.split('/');
  let index = 0;
  let name: string | null = null;
  while (index < segments.length) {
    if (segments[index] !== 'node_modules') return null;
    index += 1;
    if (index >= segments.length) return null;
    const first = segments[index]!;
    if (first.startsWith('@')) {
      if (index + 1 >= segments.length) return null;
      const second = segments[index + 1]!;
      if (second.length === 0 || second.startsWith('@')) return null;
      name = `${first}/${second}`;
      index += 2;
    } else {
      if (first.length === 0) return null;
      name = first;
      index += 1;
    }
  }
  return name;
};

export interface LockEntry {
  key: string;
  name: string;
  version: string;
  hasInstallScript: boolean;
}
export interface ValidatedLock {
  installed: LockEntry[];
  bundledCount: number;
}

// The frozen tree. Only lockfile version 3 is accepted, only registry
// resolutions are accepted, and the root must be exactly the release the
// request asked for.
export const validateLock = (
  lock: unknown,
  root: { name: string; version: string; integrity: string },
  origin: string,
): ValidatedLock => {
  const unsupported = () => new PackageFault('unsupported_dependency');
  const document = asRecord(lock);
  if (!document) throw unsupported();
  if (document.lockfileVersion !== 3) throw unsupported();
  const packages = asRecord(document.packages);
  if (!packages) throw unsupported();
  const rootKey = `node_modules/${root.name}`;
  const installed: LockEntry[] = [];
  let bundledCount = 0;
  let rootSeen = false;
  for (const [key, value] of Object.entries(packages)) {
    if (key === '') continue;
    const entry = asRecord(value);
    if (!entry) throw unsupported();
    if (entry.link === true) throw unsupported();
    const name = lockName(key);
    if (name === null) throw unsupported();
    if (!PackageProvenanceSchema.shape.name.safeParse(name).success)
      throw unsupported();
    // A name that differs from its folder is an alias.
    if (entry.name !== undefined && entry.name !== name) throw unsupported();
    const isRoot = key === rootKey;
    if (entry.inBundle === true) {
      // A bundled copy arrives inside the tarball of its parent: it has no
      // resolution of its own and is counted, never looked up.
      if (isRoot) throw unsupported();
      bundledCount += 1;
      continue;
    }
    if (!isRoot && (entry.dev === true || entry.optional === true)) continue;
    const version = entry.version;
    if (
      typeof version !== 'string' ||
      !PackageProvenanceSchema.shape.version.safeParse(version).success
    )
      throw unsupported();
    const resolved = entry.resolved;
    if (typeof resolved !== 'string' || !resolved.startsWith(`${origin}/`))
      throw unsupported();
    const integrity = entry.integrity;
    if (
      typeof integrity !== 'string' ||
      !PackageProvenanceSchema.shape.integrity.safeParse(integrity).success
    )
      throw unsupported();
    if (isRoot) {
      if (version !== root.version || integrity !== root.integrity)
        throw new PackageFault('integrity_mismatch');
      rootSeen = true;
    }
    installed.push({
      key,
      name,
      version,
      hasInstallScript: entry.hasInstallScript === true,
    });
  }
  if (!rootSeen) throw new PackageFault('integrity_mismatch');
  installed.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  return { installed, bundledCount };
};

// A bounded parallel map: the limit is the number of requests in flight.
const mapLimited = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let index = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      // After the first failure no worker starts another request.
      while (!failed) {
        const current = index++;
        if (current >= items.length) return;
        try {
          results[current] = await fn(items[current]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  const settled = await Promise.allSettled(workers);
  for (const outcome of settled)
    if (outcome.status === 'rejected') throw outcome.reason;
  return results;
};

// The version document of one package.
const documentHasInstallScript = (record: Record<string, unknown>): boolean => {
  if (record.gypfile === true) return true;
  const scripts = asRecord(record.scripts);
  if (!scripts) return false;
  for (const name of ['preinstall', 'install', 'postinstall'])
    if (typeof scripts[name] === 'string' && scripts[name]!.length > 0)
      return true;
  return false;
};
// Every dependency declaration of a version document has to name a registry
// release. A file, a link, a workspace, an alias, a git reference, an URL and
// a path are refused even when npm would only prune them.
const documentDependencies = (record: Record<string, unknown>): void => {
  for (const field of DEPENDENCY_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    const specs = asRecord(value);
    if (!specs) throw new PackageFault('unsupported_dependency');
    for (const spec of Object.values(specs))
      if (typeof spec !== 'string' || !isRegistrySpec(spec))
        throw new PackageFault('unsupported_dependency');
  }
};

// The summary of one version document: everything the preview needs from it.
// Only the summary is kept, so a tree of thousands of packages never holds
// the documents themselves in memory.
interface DocumentSummary {
  installScript: boolean;
  optional: boolean;
  unpackedSize: number | null;
  fileCount: number | null;
}

// The summary of a version document: the scripts of the package, whether it
// has optional dependencies and how big it is. A size the registry does not
// report is null and never counted.
const summarizeDocument = (
  record: Record<string, unknown>,
): DocumentSummary => {
  const dist = asRecord(record.dist);
  const size = asNumber(dist?.unpackedSize);
  const files = asNumber(dist?.fileCount);
  const optional = asRecord(record.optionalDependencies);
  return {
    installScript: documentHasInstallScript(record),
    optional: optional !== null && Object.keys(optional).length > 0,
    unpackedSize: size === null || size < 0 ? null : size,
    fileCount: files === null || files < 0 ? null : files,
  };
};

// The staging manifest of one package: the exact bytes the hub writes into
// the staging project of a lookup and into the install folder of an install.
// Both have to be the same, so npm resolves and installs the same tree.
export const stagingPackageJson = (name: string, version: string): string =>
  `${JSON.stringify({
    private: true,
    dependencies: { [name]: version },
  })}\n`;

export interface ResolvePackageOptions {
  request: PackageResolveRequest;
  owner: string;
  packagesDir: string;
  signal: AbortSignal;
  previews: PreviewStore;
  // The folder id of the job. The service passes the id of its own job, so it
  // knows which job folders are live while the lookup runs.
  jobId?: string;
  registry?: RegistryTarget;
  nodeExecutable?: string;
  now?: () => Date;
  runner?: ProcessRunner;
  onProgress?: (progress: {
    downloadedBytes: number;
    packages: number;
  }) => void;
}

// The lookup: metadata, a frozen tree in a job folder, the validation of that
// tree, the warnings and the stored preview. Nothing of the registry, nothing
// of npm and nothing of the job folder ever reaches the caller.
export const resolvePackage = async (
  options: ResolvePackageOptions,
): Promise<PackagePreview> => {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const now = options.now ?? (() => new Date());
  const request = options.request;
  const name = request.name;

  await assertNoAncestorProject(options.packagesDir);
  if ((await freeBytes(options.packagesDir)) < MIN_FREE_BYTES)
    throw new PackageFault('install_limit');

  const fetcher = createRegistryFetcher({
    origin: registry.origin,
    ...(registry.ca === undefined ? {} : { ca: registry.ca }),
  });

  // The release: an exact version as given; otherwise the abbreviated
  // packument picks it the way npm does. A dist-tag (latest when none is given)
  // names its release; for a range, the latest tag when it satisfies the range,
  // else the highest version that does. Then the full version document.
  let version = request.version ?? 'latest';
  if (!exactVersion.safeParse(version).success) {
    if (!isRegistrySpec(version)) throw new PackageFault('version_not_found');
    const packument = asRecord(
      await fetcher.getJson(registryPath(name), {
        maxBytes: MAX_ABBREVIATED_BYTES,
        accept: 'application/vnd.npm.install-v1+json',
        signal: options.signal,
      }),
    );
    if (!packument) throw new PackageFault('package_not_found');
    const tags = asRecord(packument['dist-tags']);
    const range = semver.validRange(version);
    let picked: unknown;
    if (range === null) picked = tags?.[version];
    else {
      const latest = tags?.latest;
      const versions = Object.keys(asRecord(packument.versions) ?? {}).filter(
        (key) => exactVersion.safeParse(key).success,
      );
      picked =
        typeof latest === 'string' &&
        versions.includes(latest) &&
        semver.satisfies(latest, range)
          ? latest
          : semver.maxSatisfying(versions, range);
    }
    if (typeof picked !== 'string' || !exactVersion.safeParse(picked).success)
      throw new PackageFault('version_not_found');
    version = picked;
  }

  const document = asRecord(
    await fetcher.getJson(registryPath(name, version), {
      maxBytes: MAX_VERSION_DOCUMENT_BYTES,
      signal: options.signal,
    }),
  );
  if (!document || document.name !== name || document.version !== version)
    throw new PackageFault('version_not_found');

  // The root integrity, the entry candidates and the dependency declarations
  // are checked before npm runs at all.
  const integrity = PackageProvenanceSchema.shape.integrity.safeParse(
    asRecord(document.dist)?.integrity,
  );
  if (!integrity.success) throw new PackageFault('integrity_mismatch');
  const entries = normalizeBin(name, document.bin);
  documentDependencies(document);

  // The summaries of the version documents of the installed packages. The
  // summary of a document is computed as soon as the document arrives and the
  // document itself is dropped.
  const rootKey = `node_modules/${name}`;
  const summaries = new Map<string, DocumentSummary>();
  // The running totals of the tree: the lookup stops as soon as the tree
  // grows past the caps, instead of fetching every document first.
  let runningUnpacked = 0;
  let runningFiles = 0;
  const addSummary = (key: string, summary: DocumentSummary): void => {
    if (summary.unpackedSize !== null) runningUnpacked += summary.unpackedSize;
    if (summary.fileCount !== null) runningFiles += summary.fileCount;
    if (runningUnpacked > MAX_UNPACKED_BYTES || runningFiles > MAX_FILE_COUNT)
      throw new PackageFault('install_limit');
    summaries.set(key, summary);
  };
  addSummary(rootKey, summarizeDocument(document));

  // The release date: the full packument carries it, but a packument that is
  // too large or without the field only means that the date is unknown.
  let releasedAt: string | null = null;
  try {
    const packument = await fetcher.getJson(registryPath(name), {
      maxBytes: MAX_FULL_PACKUMENT_BYTES,
      signal: options.signal,
    });
    const stamp = asRecord(asRecord(packument)?.time)?.[version];
    if (typeof stamp === 'string') {
      const date = new Date(stamp);
      if (!Number.isNaN(date.getTime())) releasedAt = date.toISOString();
    }
  } catch (error) {
    if (!(error instanceof PackageFault) || error.code !== 'install_limit')
      throw error;
  }

  const jobId = options.jobId ?? randomUUID();
  try {
    const paths = await prepareJob(options.packagesDir, jobId, registry);
    await writeFile(
      join(paths.project, 'package.json'),
      stagingPackageJson(name, version),
      { flag: 'wx', mode: 0o600 },
    );
    // The watchdog measures the job folder while npm runs. A breach is a
    // limit, not a fault of the run, so it is reported before the run itself.
    const watched = await withWatchdog(
      {
        roots: [paths.root],
        maxBytes: WATCHDOG_MAX_BYTES,
        maxFiles: WATCHDOG_MAX_FILES,
        // The reserve of the drive is kept while npm runs, not only before it.
        minFreeBytes: MIN_FREE_BYTES,
        freePath: options.packagesDir,
      },
      options.signal,
      async (signal) =>
        runNpm({
          command: 'lock',
          prefix: paths.project,
          paths,
          registry,
          signal,
          downloadCapBytes: DOWNLOAD_CAP_BYTES,
          timeoutMs: NPM_TIMEOUT_MS,
          ...(options.nodeExecutable === undefined
            ? {}
            : { nodeExecutable: options.nodeExecutable }),
          ...(options.runner === undefined ? {} : { runner: options.runner }),
        }),
    );
    if (watched.breached) throw new PackageFault('install_limit');
    const run = watched.value;
    const fault = npmFault(run, options.signal);
    if (fault) throw new PackageFault(fault);

    // The frozen lock.
    const lockPath = join(paths.project, 'package-lock.json');
    const lockBytes = await readOwnedFile(lockPath, MAX_LOCK_BYTES);
    if (!lockBytes) throw new PackageFault('install_failed');
    let lock: unknown;
    try {
      lock = JSON.parse(lockBytes.toString('utf8'));
    } catch {
      throw new PackageFault('install_failed');
    }
    const validated = validateLock(
      lock,
      { name, version, integrity: integrity.data },
      registry.origin,
    );
    // A tree that is too wide is refused before a single version document of
    // a dependency is fetched. Bundled copies are packages on disk too.
    if (validated.installed.length + validated.bundledCount > MAX_PACKAGE_COUNT)
      throw new PackageFault('install_limit');
    options.onProgress?.({
      downloadedBytes: run.downloadedBytes,
      packages: validated.installed.length,
    });

    // The version document of every installed package: the dependency
    // declarations, the size and the scripts of each one. Only the summary
    // of a document is kept.
    const others = validated.installed.filter((entry) => entry.key !== rootKey);
    await mapLimited(others, PARALLEL_LIMIT, async (entry) => {
      const fetched = asRecord(
        await fetcher.getJson(registryPath(entry.name, entry.version), {
          maxBytes: MAX_VERSION_DOCUMENT_BYTES,
          signal: options.signal,
        }),
      );
      if (!fetched) throw new PackageFault('unsupported_dependency');
      documentDependencies(fetched);
      addSummary(entry.key, summarizeDocument(fetched));
    });

    // The totals of the tree, read from the summaries: the same numbers the
    // running totals carried.
    let unpackedSize = 0;
    let sizeUnknown = false;
    let fileCount = 0;
    for (const entry of validated.installed) {
      const summary = summaries.get(entry.key);
      if (!summary) throw new PackageFault('unsupported_dependency');
      if (summary.unpackedSize === null) sizeUnknown = true;
      else unpackedSize += summary.unpackedSize;
      if (summary.fileCount !== null) fileCount += summary.fileCount;
    }
    if (unpackedSize > MAX_UNPACKED_BYTES || fileCount > MAX_FILE_COUNT)
      throw new PackageFault('install_limit');

    // The warnings of the preview.
    const flags = new Set<PackageWarning>();
    const lockPackages = asRecord(asRecord(lock)?.packages) ?? {};
    for (const entry of validated.installed) {
      const summary = summaries.get(entry.key);
      if (entry.hasInstallScript || (summary && summary.installScript))
        flags.add('install_scripts');
      const lockEntry = asRecord(lockPackages[entry.key]);
      const lockKnows =
        lockEntry !== null && typeof lockEntry.hasInstallScript === 'boolean';
      if (!lockKnows && !summary) flags.add('install_scripts_unknown');
      if (summary?.optional) flags.add('optional_omitted');
    }
    // A bundled copy has no version document of its own, so nothing tells
    // whether it runs a script unless the lock says it does.
    for (const value of Object.values(lockPackages)) {
      const lockEntry = asRecord(value);
      if (lockEntry?.inBundle !== true) continue;
      flags.add(
        lockEntry.hasInstallScript === true
          ? 'install_scripts'
          : 'install_scripts_unknown',
      );
    }
    if (releasedAt === null) flags.add('release_date_unknown');
    else if (
      now().getTime() - new Date(releasedAt).getTime() <
      RECENT_RELEASE_MS
    )
      flags.add('recent_release');
    if (
      typeof document.deprecated === 'string' &&
      document.deprecated.length > 0
    )
      flags.add('deprecated');
    const engines = asRecord(document.engines);
    const engineRange = engines?.node;
    if (typeof engineRange === 'string' && engineRange.length > 0) {
      let satisfied = true;
      try {
        satisfied = semver.satisfies(process.versions.node, engineRange);
      } catch {
        satisfied = true;
      }
      if (!satisfied) flags.add('engine_mismatch');
    }
    if (validated.installed.length > WARNING_PACKAGE_COUNT)
      flags.add('many_packages');
    if (unpackedSize > WARNING_UNPACKED_BYTES) flags.add('large_size');
    if (sizeUnknown) flags.add('size_unknown');
    const warnings = WARNING_ORDER.filter((warning) => flags.has(warning));
    const ttlMs = options.previews.ttlMs ?? PREVIEW_TTL_MS;
    const preview: PackagePreview = {
      previewId: randomUUID(),
      name,
      version,
      description:
        typeof document.description === 'string'
          ? document.description.slice(0, 1000)
          : null,
      integrity: integrity.data,
      lockHash: createHash('sha256').update(lockBytes).digest('hex'),
      packageCount: validated.installed.length,
      bundledCount: validated.bundledCount,
      unpackedSize: sizeUnknown ? null : unpackedSize,
      releasedAt,
      entries,
      warnings,
      expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
    };
    options.previews.put({
      preview,
      lock: lockBytes,
      jobId,
      owner: options.owner,
    });
    return preview;
  } catch (error) {
    // The job folder of a failed lookup never survives the failure.
    await removeTree(
      jobDirectory(options.packagesDir, jobId),
      options.packagesDir,
    ).catch(() => false);
    throw error;
  }
};
