import { randomUUID } from 'node:crypto';
import {
  IdSchema,
  PackageInstallRequestSchema,
  PackageResolveRequestSchema,
  type HubState,
  type ImportDefinition,
  type Job,
  type OperationPreview,
  type PackageErrorCode,
  type PackageJob,
  type PackagePreview,
  type PackageProvenance,
} from '@waleed/contracts';
import { HubError } from '../errors.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import {
  packageArguments,
  planRegistry,
  type RegistryContext,
} from '../runtime/registry.js';
import { assertBinding } from '../auth/bindings.js';
import { assertNoCredentialEcho } from '../integrations/bridge.js';
import { writeCredentialValues } from '../integrations/manual.js';
import type { ProcessRunner } from '../ports.js';
import { PackageFault } from './fault.js';
import {
  installPackage,
  type CommitState,
  type SaveOutcome,
} from './install.js';
import { DEFAULT_REGISTRY, type RegistryTarget } from './npm.js';
import { createPreviewStore, type PreviewStore } from './previews.js';
import { resolvePackage } from './resolve.js';
import { createPackageLock, type PackageLock } from './store.js';
import { verifyPackageFiles } from './verify.js';

// The bounds of the service: the job records are bounded, one install runs at
// a time, two lookups at a time and every job has the deadline of the spec.
const MAX_RECORDS = 100;
const MAX_INSTALLS = 1;
const MAX_LOOKUPS = 2;
const DEADLINE_MS = 600_000;
const MAX_ENV_NAMES = 16;
// The mutation slot is short. A momentary busy is never a reason to throw an
// install away, so the save retries before it gives up.
const SAVE_ATTEMPTS = 40;
const SAVE_RETRY_MS = 250;
// The placeholder provenance of the dry run: a valid record that names no
// package, so the plan can be built without the real install.
const PLACEHOLDER_INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const ZERO_HASH = '0'.repeat(64);

export interface PackageServiceAdapter {
  packagesDir: string;
  nodeExecutable: string;
  registry?: RegistryTarget;
  runner?: ProcessRunner;
  now?: () => number;
}

// The narrow host of the service: the lifecycle offers more than the service
// needs, and the service never sees the whole lifecycle.
export interface PackageHost {
  preview(
    raw: unknown,
    owner: string,
    context?: RegistryContext,
  ): Promise<OperationPreview>;
  apply(previewId: string, owner: string): Promise<Job>;
  drain(): Promise<void>;
  job(id: string, owner: string): Job;
  inventory(): Promise<HubState>;
  auth: {
    credentials: {
      write(connectorId: string, raw: unknown): Promise<unknown>;
    };
  };
}

export interface PackageVerifyResult {
  connectorId: string;
  result: 'verified' | 'package_modified' | 'invalid_configuration';
}

export interface PackageService {
  resolve(raw: unknown, owner: string): PackageJob;
  install(raw: unknown, owner: string): Promise<PackageJob>;
  job(id: string, owner: string): PackageJob;
  cancel(id: string, owner: string): PackageJob;
  verify(connectorId: string): Promise<PackageVerifyResult>;
  // Every job folder that is live: the folder of a running lookup, the
  // folders of the stored previews and the folder of a running install.
  activeJobs(): ReadonlySet<string>;
  lock: PackageLock;
  close(): Promise<void>;
}

// One job of the service: the record, the controller that stops it and the
// promise that settles when its run returned.
interface JobRecord {
  owner: string;
  job: PackageJob;
  controller: AbortController;
  userCancelled: boolean;
  commitState: CommitState;
  folderId?: string;
  done: Promise<void>;
}

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// The environment map of a raw request, so its values can be blanked as soon
// as the request was read.
const environmentMap = (raw: unknown): Record<string, string> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const env = (raw as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
  return env as Record<string, string>;
};
const blank = (values: Record<string, string> | undefined): void => {
  if (!values) return;
  for (const name of Object.keys(values)) values[name] = '';
};

export function createPackageService(
  host: PackageHost,
  adapter: PackageServiceAdapter,
): PackageService {
  const now = adapter.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();
  const registry = adapter.registry ?? DEFAULT_REGISTRY;
  const previews: PreviewStore = createPreviewStore({
    packagesDir: adapter.packagesDir,
    now,
  });
  const lock = createPackageLock();
  const records = new Map<string, JobRecord>();
  let closed = false;
  let installs = 0;
  let lookups = 0;

  const snapshot = (entry: JobRecord): PackageJob => structuredClone(entry.job);

  // The bounded retention: the oldest finished record makes room for a new
  // one. A hundred running jobs are refused instead of evicted.
  const reserve = (): void => {
    if (records.size < MAX_RECORDS) return;
    for (const [id, entry] of records)
      if (entry.job.completedAt) {
        records.delete(id);
        break;
      }
    if (records.size >= MAX_RECORDS)
      throw new HubError('busy', 'Too many package jobs are in flight.');
  };

  const createJob = (
    kind: 'resolve' | 'install',
    phase: PackageJob['phase'],
    owner: string,
  ): JobRecord => {
    const job: PackageJob = {
      id: randomUUID(),
      kind,
      state: 'running',
      createdAt: timestamp(),
      completedAt: null,
      phase,
      progress: { downloadedBytes: 0, packages: 0 },
      error: null,
      preview: null,
      result: null,
    };
    const entry: JobRecord = {
      owner,
      job,
      controller: new AbortController(),
      userCancelled: false,
      commitState: 'precommit',
      done: Promise.resolve(),
    };
    records.set(job.id, entry);
    return entry;
  };

  // The sanitized failure of a job: a code of the contract and nothing else.
  // No message, no path, no registry text and no npm output ever reaches it.
  const errorCode = (
    error: unknown,
    userCancelled: boolean,
    aborted: boolean,
  ): PackageErrorCode => {
    let code: PackageErrorCode;
    if (error instanceof PackageFault) code = error.code;
    else if (
      error instanceof RuntimeFault &&
      (error.reason === 'package_modified' ||
        error.reason === 'invalid_configuration')
    )
      code = error.reason;
    // A run that was stopped reports the cancellation, never a raw failure.
    else if (aborted) code = 'cancelled';
    else code = 'install_failed';
    // A run that stopped without the user asking for it hit the deadline.
    if (code === 'cancelled' && !userCancelled) code = 'install_limit';
    return code;
  };

  const contextFor = (provenance: PackageProvenance): RegistryContext => ({
    trustedPackage: provenance,
    nodeExecutable: adapter.nodeExecutable,
    packagesDir: adapter.packagesDir,
  });

  const placeholderProvenance = (): PackageProvenance => ({
    ecosystem: 'npm',
    name: 'placeholder',
    version: '0.0.0',
    entry: 'index',
    entryPath: 'index.js',
    installId: randomUUID(),
    integrity: PLACEHOLDER_INTEGRITY,
    lockHash: ZERO_HASH,
    manifestHash: ZERO_HASH,
  });

  const connectorDefinition = (
    id: string,
    name: string,
    provenance: PackageProvenance,
    args: readonly string[],
  ): ImportDefinition => ({
    id,
    name,
    description: 'Managed npm package',
    enabled: true,
    environmentLiterals: {},
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
    executionMode: 'native',
    transport: 'stdio',
    executable: adapter.nodeExecutable,
    arguments: packageArguments(adapter.packagesDir, provenance, args),
    package: provenance,
  });

  const resolve = (raw: unknown, owner: string): PackageJob => {
    if (closed)
      throw new HubError('unavailable', 'Managed packages are not available.');
    const request = PackageResolveRequestSchema.parse(raw);
    if (lookups >= MAX_LOOKUPS)
      throw new HubError('busy', 'Two package lookups are already running.');
    reserve();
    const entry = createJob('resolve', 'resolving', owner);
    // The lookup folder carries the id of the job, so the reconciliation
    // never deletes a folder of a running lookup.
    entry.folderId = entry.job.id;
    lookups += 1;
    const signal = AbortSignal.any([
      entry.controller.signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    entry.done = (async () => {
      try {
        const preview: PackagePreview = await resolvePackage({
          request,
          owner,
          packagesDir: adapter.packagesDir,
          signal,
          previews,
          jobId: entry.job.id,
          registry,
          nodeExecutable: adapter.nodeExecutable,
          now: () => new Date(now()),
          ...(adapter.runner === undefined ? {} : { runner: adapter.runner }),
          onProgress: (progress) => {
            entry.job.progress = { ...progress };
          },
        });
        entry.job.preview = preview;
        entry.job.phase = 'complete';
        entry.job.state = 'succeeded';
      } catch (error) {
        const code = errorCode(error, entry.userCancelled, signal.aborted);
        entry.job.error = code;
        entry.job.state = code === 'cancelled' ? 'cancelled' : 'failed';
      } finally {
        entry.job.completedAt = timestamp();
        lookups -= 1;
      }
    })();
    return snapshot(entry);
  };

  const install = async (raw: unknown, owner: string): Promise<PackageJob> => {
    if (closed)
      throw new HubError('unavailable', 'Managed packages are not available.');
    const rawEnv = environmentMap(raw);
    let request: ReturnType<typeof PackageInstallRequestSchema.parse>;
    try {
      request = PackageInstallRequestSchema.parse(raw);
    } catch (error) {
      blank(rawEnv);
      throw error;
    }
    // The service keeps its own copy of the values and blanks it as soon as
    // the job is over. No value ever reaches a job, a route or an error.
    const env: Record<string, string> = { ...request.env };
    const connectorId = `package-${randomUUID()}`;
    // The slot is taken before the first await, so two installs never pass the
    // check at the same time.
    if (installs >= MAX_INSTALLS)
      throw new HubError('busy', 'A package install is already running.');
    installs += 1;
    try {
      const names = Object.keys(env);
      if (names.length > MAX_ENV_NAMES)
        throw new HubError(
          'invalid',
          'At most 16 credential bindings can be saved at once.',
        );
      for (const name of names) assertBinding('environment', name, 'raw');
      // The dry run of the save: the plan is built against the current state
      // and commits nothing. A refused name, an argument or the connector
      // limit is reported before anything is downloaded.
      const placeholder = placeholderProvenance();
      const definition = connectorDefinition(
        connectorId,
        request.connectorName,
        placeholder,
        request.arguments,
      );
      const state = await host.inventory();
      planRegistry(
        {
          kind: 'create_connector',
          expectedRevision: state.revision,
          definition,
        },
        state,
        connectorId,
        timestamp(),
        contextFor(placeholder),
      );
      try {
        assertNoCredentialEcho(definition, Object.values(env));
      } catch {
        throw new HubError(
          'invalid',
          'Credential values cannot appear in public names, commands, arguments or URLs.',
        );
      }
      reserve();
    } catch (error) {
      installs -= 1;
      blank(rawEnv);
      blank(env);
      blank(request.env);
      throw error;
    }
    const entry = createJob('install', 'queued', owner);
    const signal = AbortSignal.any([
      entry.controller.signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);

    // The credential values are written after the connector exists. A failure
    // leaves the connector and its folder in place: the save is partial, not
    // lost.
    const commitCredentials = async (): Promise<SaveOutcome> => {
      try {
        await writeCredentialValues(
          host,
          connectorId,
          'environment',
          env,
          'windows',
        );
      } catch {
        return {
          status: 'committed',
          connectorId,
          outcome: 'partially_saved',
        };
      }
      return { status: 'committed', connectorId, outcome: 'saved' };
    };

    const jobState = (id: string): string | null => {
      try {
        return host.job(id, owner).state;
      } catch {
        return null;
      }
    };

    // The internal save of the connector. It runs under the package lock,
    // because the installer calls it there: the marker is gone and the folder
    // is published, so the state write and the credential values belong to
    // the same critical section.
    const savePackageConnector = async (
      provenance: PackageProvenance,
    ): Promise<SaveOutcome> => {
      const saved = connectorDefinition(
        connectorId,
        request.connectorName,
        provenance,
        request.arguments,
      );
      const context = contextFor(provenance);
      let busy = false;
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
        let applied: Job;
        try {
          const current = await host.inventory();
          const preview = await host.preview(
            {
              kind: 'create_connector',
              expectedRevision: current.revision,
              definition: saved,
            },
            owner,
            context,
          );
          applied = await host.apply(preview.id, owner);
        } catch (error) {
          if (error instanceof HubError && error.code === 'busy') {
            busy = true;
            await delay(SAVE_RETRY_MS);
            continue;
          }
          return { status: 'not_committed', error: 'install_failed' };
        }
        // Once the mutation was accepted, only the registry can say whether it
        // committed: a failure from here on is never "nothing committed".
        let settled = true;
        try {
          await host.drain();
        } catch {
          settled = false;
        }
        if (settled && jobState(applied.id) === 'succeeded')
          return commitCredentials();
        // The mutation did not succeed. The registry decides whether the
        // connector exists: a write that may have committed is uncertain.
        let current: HubState;
        try {
          current = await host.inventory();
        } catch {
          return { status: 'indeterminate' };
        }
        const stored = current.connectors.find(
          (item) => item.id === connectorId,
        );
        if (!stored)
          return { status: 'not_committed', error: 'install_failed' };
        if (
          stored.executionMode === 'native' &&
          stored.package?.installId === provenance.installId
        )
          return commitCredentials();
        return { status: 'indeterminate' };
      }
      return {
        status: 'not_committed',
        error: busy ? 'busy' : 'install_failed',
      };
    };

    entry.done = (async () => {
      try {
        const record = await previews.take(request.previewId, owner);
        entry.folderId = record.jobId;
        entry.job.progress = {
          ...entry.job.progress,
          packages: record.preview.packageCount,
        };
        const saved = await installPackage({
          record,
          entry: request.entry,
          acknowledgedWarnings: request.acknowledgedWarnings,
          packagesDir: adapter.packagesDir,
          lock,
          signal,
          save: (provenance) => savePackageConnector(provenance),
          registry,
          nodeExecutable: adapter.nodeExecutable,
          ...(adapter.runner === undefined ? {} : { runner: adapter.runner }),
          onPhase: (phase) => {
            entry.job.phase = phase;
          },
          onCommitState: (state) => {
            entry.commitState = state;
          },
        });
        entry.job.result = {
          connectorId: saved.connectorId,
          outcome: saved.outcome,
        };
        entry.job.phase = 'complete';
        entry.job.state = 'succeeded';
      } catch (error) {
        const code = errorCode(error, entry.userCancelled, signal.aborted);
        entry.job.error = code;
        entry.job.state = code === 'cancelled' ? 'cancelled' : 'failed';
      } finally {
        blank(env);
        blank(request.env);
        blank(rawEnv);
        entry.job.completedAt = timestamp();
        installs -= 1;
      }
    })();

    return snapshot(entry);
  };

  const job = (id: string, owner: string): PackageJob => {
    const entry = records.get(id);
    if (!entry || entry.owner !== owner)
      throw new HubError('not_found', 'Job not found in this session.');
    return snapshot(entry);
  };

  const cancel = (id: string, owner: string): PackageJob => {
    const entry = records.get(id);
    if (!entry || entry.owner !== owner)
      throw new HubError('not_found', 'Job not found in this session.');
    if (entry.job.completedAt) return snapshot(entry);
    // The save has started: the job reports its real outcome and nothing is
    // thrown away half way.
    if (entry.commitState === 'committing')
      throw new HubError(
        'busy',
        'The save has started. The job reports its real outcome.',
      );
    entry.userCancelled = true;
    entry.controller.abort();
    return snapshot(entry);
  };

  const verify = async (connectorId: string): Promise<PackageVerifyResult> => {
    const id = IdSchema.parse(connectorId);
    const state = await host.inventory();
    const connector = state.connectors.find((item) => item.id === id);
    if (!connector) throw new HubError('not_found', 'Connector not found.');
    if (connector.executionMode !== 'native' || !connector.package)
      throw new HubError('invalid', 'This connector is not a managed package.');
    try {
      // The verification runs under the package lock and starts no process.
      await lock.run(() => verifyPackageFiles(connector, adapter.packagesDir));
    } catch (error) {
      if (
        error instanceof RuntimeFault &&
        (error.reason === 'package_modified' ||
          error.reason === 'invalid_configuration')
      )
        return { connectorId: id, result: error.reason };
      throw error;
    }
    return { connectorId: id, result: 'verified' };
  };

  const activeJobs = (): ReadonlySet<string> => {
    const active = new Set<string>();
    for (const entry of records.values()) {
      if (entry.job.completedAt) continue;
      if (entry.folderId) active.add(entry.folderId);
    }
    for (const id of previews.jobIds()) active.add(id);
    return active;
  };

  const close = async (): Promise<void> => {
    closed = true;
    for (const entry of records.values()) {
      if (entry.job.completedAt) continue;
      // A committing job finishes on its own: its outcome is the truth.
      if (entry.commitState === 'committing') continue;
      entry.controller.abort();
    }
    await Promise.allSettled([...records.values()].map((entry) => entry.done));
    previews.dispose();
  };

  return {
    resolve,
    install,
    job,
    cancel,
    verify,
    activeJobs,
    lock,
    close,
  };
}
