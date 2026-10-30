import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type {
  PackageErrorCode,
  PackageProvenance,
  PackageWarning,
} from '@waleed/contracts';
import { PackageProvenanceSchema } from '@waleed/contracts';
import { assertNoLinks } from '../adapters/managed-files.js';
import type { ProcessRunner } from '../ports.js';
import { normalizeBin, type NormalizedBin } from './entry.js';
import { PackageFault } from './fault.js';
import {
  DEFAULT_REGISTRY,
  assertNoAncestorProject,
  jobPaths,
  npmFault,
  prepareJob,
  runNpm,
  type JobPaths,
  type RegistryTarget,
} from './npm.js';
import type { PreviewRecord } from './previews.js';
import { stagingPackageJson } from './resolve.js';
import {
  createPrivateDirectory,
  installDirectory,
  jobDirectory,
  removeMarker,
  removeTree,
  writeMarker,
  type PackageLock,
} from './store.js';
import { buildManifest } from './verify.js';
import {
  WATCHDOG_MAX_BYTES,
  WATCHDOG_MAX_FILES,
  freeBytes,
  withWatchdog,
  type WatchdogOptions,
} from './watchdog.js';

// The limits of one install: the drive keeps a reserve, the tree keeps the
// unpacked cap of the spec and the proxy keeps the download cap.
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_CAP_BYTES = 300 * 1024 * 1024;
const NPM_TIMEOUT_MS = 600_000;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
// The install folder holds the two files and the modules, nothing else.
const INSTALL_TOP_LEVEL = new Set([
  'package.json',
  'package-lock.json',
  'node_modules',
]);

// The outcome of the save: the connector is stored, the save changed nothing,
// or the hub cannot tell whether the state write committed.
export type SaveOutcome =
  | {
      status: 'committed';
      connectorId: string;
      outcome: 'saved' | 'partially_saved';
    }
  | { status: 'not_committed'; error: PackageErrorCode }
  | { status: 'indeterminate' };

// The commit state of an install: the folder is a staging folder, the save is
// running, the save committed or the save stays uncertain.
export type CommitState =
  'precommit' | 'committing' | 'committed' | 'indeterminate';

export interface InstallPackageOptions {
  record: PreviewRecord;
  entry: string;
  acknowledgedWarnings: readonly PackageWarning[];
  packagesDir: string;
  lock: PackageLock;
  signal: AbortSignal;
  save: (provenance: PackageProvenance) => Promise<SaveOutcome>;
  registry?: RegistryTarget;
  nodeExecutable?: string;
  runner?: ProcessRunner;
  watchdog?: Pick<WatchdogOptions, 'intervalMs' | 'scan'>;
  onPhase?: (phase: 'downloading' | 'verifying' | 'saving') => void;
  onCommitState?: (state: CommitState) => void;
}

export interface InstallPackageResult {
  connectorId: string;
  outcome: 'saved' | 'partially_saved';
  provenance: PackageProvenance;
}

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
};
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

// The job folder of the preview holds the cache, the temporary folder, the
// CA and the two empty configuration files of the npm run. The lookup created
// it; when it is gone, the install prepares a complete one again.
const ensureJobFolder = async (
  packagesDir: string,
  jobId: string,
  registry: RegistryTarget,
  paths: JobPaths,
): Promise<void> => {
  if (!(await exists(paths.root)))
    await prepareJob(packagesDir, jobId, registry);
};

// The install folder holds the two files and the modules, and nothing npm
// leaves behind: no ".npmrc" and no "_logs" anywhere in the tree.
const assertInstallTree = async (installFolder: string): Promise<void> => {
  for (const name of await readdir(installFolder))
    if (!INSTALL_TOP_LEVEL.has(name)) throw new PackageFault('install_failed');
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      if (name === '.npmrc' || name === '_logs')
        throw new PackageFault('install_failed');
      const info = await lstat(join(directory, name));
      if (info.isDirectory()) await walk(join(directory, name));
    }
  };
  await walk(join(installFolder, 'node_modules'));
};

// The verification of an install folder: the frozen lock is unchanged, the
// entry is the one the preview offered, the entry file is a plain file inside
// the folder, nothing else is in the folder and the manifest is built. Every
// failure is closed and carries no path and no npm output.
const verifyInstall = async (
  installFolder: string,
  name: string,
  candidate: { entry: string; entryPath: string },
  lockHash: string,
): Promise<string> => {
  try {
    await assertNoLinks(installFolder, true);
    const lockPath = join(installFolder, 'package-lock.json');
    const lockInfo = await lstat(lockPath);
    if (!lockInfo.isFile() || lockInfo.nlink !== 1)
      throw new PackageFault('integrity_mismatch');
    const lockBytes = await readFile(lockPath);
    if (createHash('sha256').update(lockBytes).digest('hex') !== lockHash)
      throw new PackageFault('integrity_mismatch');

    const packageFolder = join(installFolder, 'node_modules', name);
    const manifestPath = join(packageFolder, 'package.json');
    const manifestInfo = await lstat(manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.nlink !== 1 ||
      manifestInfo.size > MAX_PACKAGE_JSON_BYTES
    )
      throw new PackageFault('install_failed');
    const installed = asRecord(
      JSON.parse((await readFile(manifestPath)).toString('utf8')),
    );
    if (!installed) throw new PackageFault('install_failed');
    let bins: NormalizedBin[];
    try {
      bins = normalizeBin(name, installed['bin']);
    } catch {
      throw new PackageFault('install_failed');
    }
    const selected = bins.find((item) => item.entry === candidate.entry);
    if (!selected || selected.entryPath !== candidate.entryPath)
      throw new PackageFault('install_failed');
    const entryFile = join(packageFolder, ...selected.entryPath.split('/'));
    const root = resolve(installFolder);
    if (
      !resolve(entryFile)
        .toLowerCase()
        .startsWith(`${root.toLowerCase()}${sep.toLowerCase()}`)
    )
      throw new PackageFault('install_failed');
    const entryInfo = await lstat(entryFile);
    if (!entryInfo.isFile() || entryInfo.nlink !== 1)
      throw new PackageFault('install_failed');

    await assertInstallTree(installFolder);
    return (await buildManifest(installFolder)).hash;
  } catch (error) {
    if (error instanceof PackageFault) throw error;
    throw new PackageFault('install_failed');
  }
};

// The install of one package: the pre-checks, the folder, the download, the
// verification and the save under the package lock. Nothing of npm, of the
// registry or of the disk ever reaches the caller: every failure is a
// PackageFault with a code of the contract.
export async function installPackage(
  options: InstallPackageOptions,
): Promise<InstallPackageResult> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const preview = options.record.preview;
  const name = preview.name;
  const version = preview.version;

  options.onCommitState?.('precommit');

  // The entry has to be one the preview offered, every warning has to be
  // acknowledged and the caller may not have given up already.
  const candidate = preview.entries.find(
    (item) => item.entry === options.entry,
  );
  if (!candidate) throw new PackageFault('no_entry');
  const acknowledged = new Set(options.acknowledgedWarnings);
  for (const warning of preview.warnings)
    if (!acknowledged.has(warning))
      throw new PackageFault('warning_not_acknowledged');
  if (options.signal.aborted) throw new PackageFault('cancelled');

  // The drive keeps a reserve and the tree keeps the unpacked cap of the spec.
  await assertNoAncestorProject(options.packagesDir);
  if ((await freeBytes(options.packagesDir)) < MIN_FREE_BYTES)
    throw new PackageFault('install_limit');
  if (
    preview.unpackedSize !== null &&
    preview.unpackedSize > MAX_UNPACKED_BYTES
  )
    throw new PackageFault('install_limit');

  const installId = randomUUID();
  const installFolder = installDirectory(options.packagesDir, installId);
  const jobFolder = jobDirectory(options.packagesDir, options.record.jobId);
  const paths = jobPaths(options.packagesDir, options.record.jobId, registry);
  // The folder survives the install only when the save committed or stayed
  // uncertain; every earlier failure deletes it.
  let keepFolder = false;
  try {
    // The marker comes first: it names the job that owns the folder while the
    // install runs.
    await writeMarker(options.packagesDir, installId, options.record.jobId);
    // The install folder is private once; everything npm writes below it
    // inherits the ACL.
    await createPrivateDirectory(installFolder);
    await writeFile(
      join(installFolder, 'package.json'),
      stagingPackageJson(name, version),
      { flag: 'wx', mode: 0o600 },
    );
    await writeFile(
      join(installFolder, 'package-lock.json'),
      options.record.lock,
      { flag: 'wx', mode: 0o600 },
    );

    // The download: npm ci in the install folder with the frozen lock. The
    // watchdog measures the job folder and the install folder together.
    options.onPhase?.('downloading');
    await ensureJobFolder(
      options.packagesDir,
      options.record.jobId,
      registry,
      paths,
    );
    const watched = await withWatchdog(
      {
        roots: [jobFolder, installFolder],
        maxBytes: WATCHDOG_MAX_BYTES,
        maxFiles: WATCHDOG_MAX_FILES,
        // The reserve of the drive is kept while npm runs, not only before it.
        minFreeBytes: MIN_FREE_BYTES,
        freePath: options.packagesDir,
        ...(options.watchdog?.intervalMs === undefined
          ? {}
          : { intervalMs: options.watchdog.intervalMs }),
        ...(options.watchdog?.scan === undefined
          ? {}
          : { scan: options.watchdog.scan }),
      },
      options.signal,
      async (signal) =>
        runNpm({
          command: 'ci',
          prefix: installFolder,
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
    const fault = npmFault(watched.value, options.signal);
    if (fault) throw new PackageFault(fault);

    // The verification.
    options.onPhase?.('verifying');
    const manifestHash = await verifyInstall(
      installFolder,
      name,
      candidate,
      preview.lockHash,
    );

    // The provenance of the install.
    const provenance: PackageProvenance = {
      ecosystem: 'npm',
      name,
      version,
      entry: options.entry,
      entryPath: candidate.entryPath,
      installId,
      integrity: preview.integrity,
      lockHash: preview.lockHash,
      manifestHash,
    };
    if (!PackageProvenanceSchema.safeParse(provenance).success)
      throw new PackageFault('install_failed');
    if (options.signal.aborted) throw new PackageFault('cancelled');

    // The save: the marker goes and the connector is written in one critical
    // section under the package lock. From here on the signal is ignored: the
    // caller refuses a cancellation with "busy" while the state is committing.
    options.onPhase?.('saving');
    const saved = await options.lock.run(async () => {
      // A cancel accepted while the install waited for the lock still wins:
      // nothing is committed yet.
      if (options.signal.aborted) throw new PackageFault('cancelled');
      options.onCommitState?.('committing');
      try {
        await removeMarker(options.packagesDir, installId);
      } catch {
        throw new PackageFault('install_failed');
      }
      let outcome: SaveOutcome;
      try {
        outcome = await options.save(provenance);
      } catch {
        // The state write may have committed and the hub cannot confirm it.
        outcome = { status: 'indeterminate' };
      }
      if (outcome.status === 'committed') {
        keepFolder = true;
        return outcome;
      }
      if (outcome.status === 'not_committed') {
        // The save is known to have changed nothing: the folder goes away.
        await removeTree(installFolder, options.packagesDir).catch(() => false);
        throw new PackageFault(outcome.error);
      }
      keepFolder = true;
      options.onCommitState?.('indeterminate');
      throw new PackageFault('save_uncertain');
    });
    options.onCommitState?.('committed');
    return {
      connectorId: saved.connectorId,
      outcome: saved.outcome,
      provenance,
    };
  } finally {
    // The job folder never survives the install.
    await removeTree(jobFolder, options.packagesDir).catch(() => false);
    // Before the save the marker and the folder go away; after it the folder
    // belongs to the connector or to the reconciliation.
    if (!keepFolder) {
      await removeMarker(options.packagesDir, installId).catch(() => undefined);
      await removeTree(installFolder, options.packagesDir).catch(() => false);
    }
  }
}
