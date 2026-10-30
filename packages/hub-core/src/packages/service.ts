import { randomUUID } from 'node:crypto';
import {
  IdSchema,
  PackageInstallRequestSchema,
  PackageReplaceRequestSchema,
  PackageResolveRequestSchema,
  type HubState,
  type ImportDefinition,
  type Job,
  type OperationPreview,
  type PackageErrorCode,
  type PackageJob,
  type PackagePreview,
  type PackageProvenance,
  type PackageWarning,
} from '@waleed/contracts';
import { HubError, isRevisionConflict } from '../errors.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import {
  packageArguments,
  planRegistry,
  type PackageReplaceInput,
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
import {
  DEFAULT_REGISTRY,
  npmSelfTest,
  prepareJob,
  type RegistryTarget,
} from './npm.js';
import { createPreviewStore, type PreviewStore } from './previews.js';
import { resolvePackage } from './resolve.js';
import {
  createPackageLock,
  jobDirectory,
  reconcilePackages,
  removeTree,
  type PackageLock,
} from './store.js';
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
// The deadline of the npm self-test: it runs on its own signal, never on the
// signal of a job.
const SELF_TEST_TIMEOUT_MS = 60_000;
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
  // The self-test of the npm the service runs. A test injects its own; it
  // replaces the real one whatever the runner is.
  selfTest?: () => Promise<void>;
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
  // The removal of a draft that will never be applied. It removes only the
  // caller's own draft and does nothing else.
  discard(previewId: string, owner: string): void;
  // The internal replacement of an installed package. Only the service calls
  // it; it is never exposed through an HTTP route.
  replacePackage(input: PackageReplaceInput, owner: string): Promise<Job>;
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
  replace(raw: unknown, owner: string): Promise<PackageJob>;
  job(id: string, owner: string): PackageJob;
  cancel(id: string, owner: string): PackageJob;
  verify(connectorId: string): Promise<PackageVerifyResult>;
  // The reconciliation of the package folders: the number of deleted and the
  // number of retained folders. Never a folder id and never a path.
  reconcile(): Promise<{ deleted: number; retained: number }>;
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

  // The startup self-test of the npm: the pinned npm is checked once, before
  // the first job runs npm. The test starts lazily, so creating the service
  // stays synchronous and cheap.
  let selfTestPromise: Promise<void> | null = null;
  // The folder of the running self-test. A fresh id per test: a folder left
  // by an earlier process is never active, so the reconciliation removes it.
  let selfTestJobId: string | null = null;
  // Shutdown stops the self-test: a cancelled job never does, but the service
  // never ends with an npm of its own still running.
  const selfTestController = new AbortController();

  // The real self-test: the bundled npm in its own job folder, which is
  // removed again when the test is over, also when preparing it fails.
  const bundledSelfTest = async (): Promise<void> => {
    const jobId = randomUUID();
    selfTestJobId = jobId;
    try {
      const paths = await prepareJob(adapter.packagesDir, jobId, registry);
      await npmSelfTest({
        paths,
        registry,
        // The test has its own deadline: a cancelled job never stops it, the
        // shutdown of the service does.
        signal: AbortSignal.any([
          selfTestController.signal,
          AbortSignal.timeout(SELF_TEST_TIMEOUT_MS),
        ]),
        nodeExecutable: adapter.nodeExecutable,
      });
    } finally {
      await removeTree(
        jobDirectory(adapter.packagesDir, jobId),
        adapter.packagesDir,
      ).catch(() => false);
      selfTestJobId = null;
    }
  };

  // The real self-test runs only for the bundled npm; an injected one replaces
  // it whatever the runner is.
  const selfTest =
    adapter.selfTest ?? (adapter.runner === undefined ? bundledSelfTest : null);

  const startSelfTest = (): Promise<void> => {
    return Promise.resolve().then(() => selfTest!());
  };

  // Every resolve and install job waits for the self-test before npm runs. A
  // cancelled job stops waiting, but the test keeps running: a broken npm
  // never becomes the result of a cancelled job.
  const ensureSelfTest = async (signal: AbortSignal): Promise<void> => {
    if (!selfTest) return;
    selfTestPromise ??= startSelfTest();
    const promise = selfTestPromise;
    // The memo never becomes an unhandled rejection, whoever waits for it.
    promise.catch(() => undefined);
    if (signal.aborted) throw new PackageFault('cancelled');
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new PackageFault('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
      // The signal may have been aborted between the check and the listener.
      if (signal.aborted) onAbort();
    }).catch((error: unknown) => {
      // A broken npm fails the job, never the service.
      if (error instanceof PackageFault) throw error;
      throw new PackageFault('install_failed');
    });
  };

  const snapshot = (entry: JobRecord): PackageJob => structuredClone(entry.job);

  // The state of a registry job of the host, or null when the hub cannot
  // read it any more.
  const jobState = (id: string, owner: string): string | null => {
    try {
      return host.job(id, owner).state;
    } catch {
      return null;
    }
  };

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
    kind: PackageJob['kind'],
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

  // The shared runner of the install and the replace job: the same preview,
  // the same phases, the same commit states, the same cancellation rules and
  // the same deadline. Only the save differs.
  const runPackageJob = (
    entry: JobRecord,
    signal: AbortSignal,
    options: {
      previewId: string;
      entry: string;
      acknowledgedWarnings: readonly PackageWarning[];
      save: (provenance: PackageProvenance) => Promise<SaveOutcome>;
      // The hook that runs after the install folder was published.
      afterSave?: () => void;
      // The cleanup that runs when the job is over.
      cleanup?: () => void;
    },
  ): Promise<void> =>
    (async () => {
      try {
        await ensureSelfTest(signal);
        const record = await previews.take(options.previewId, entry.owner);
        entry.folderId = record.jobId;
        entry.job.progress = {
          ...entry.job.progress,
          packages: record.preview.packageCount,
        };
        const saved = await installPackage({
          record,
          entry: options.entry,
          acknowledgedWarnings: options.acknowledgedWarnings,
          packagesDir: adapter.packagesDir,
          lock,
          signal,
          save: options.save,
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
        // The old folder is unreferenced now. It goes away in the background,
        // never inside the save that runs under the package lock.
        options.afterSave?.();
      } catch (error) {
        const code = errorCode(error, entry.userCancelled, signal.aborted);
        entry.job.error = code;
        entry.job.state = code === 'cancelled' ? 'cancelled' : 'failed';
      } finally {
        options.cleanup?.();
        entry.job.completedAt = timestamp();
        installs -= 1;
      }
    })();

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
        await ensureSelfTest(signal);
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
    const rawEnv = environmentMap(raw);
    if (closed) {
      blank(rawEnv);
      throw new HubError('unavailable', 'Managed packages are not available.');
    }
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
    // check at the same time. The refusal is inside the scope that blanks the
    // values: a busy install keeps no credential value in memory.
    let slotTaken = false;
    try {
      if (installs >= MAX_INSTALLS)
        throw new HubError('busy', 'A package install is already running.');
      installs += 1;
      slotTaken = true;
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
      if (slotTaken) installs -= 1;
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
      // The draft of the save. It is built once and applied again while the
      // registry is busy, so a retry never leaves an unused draft behind.
      let previewId: string | null = null;
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
        let applied: Job;
        try {
          if (previewId === null) {
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
            previewId = preview.id;
          }
          applied = await host.apply(previewId, owner);
        } catch (error) {
          // A busy mutation committed nothing: the same draft is applied
          // again, so the retry costs no second preview.
          if (error instanceof HubError && error.code === 'busy') {
            busy = true;
            await delay(SAVE_RETRY_MS);
            continue;
          }
          // The inventory moved between the inventory read and the apply:
          // nothing was committed, so the save is tried again with the
          // revision of the moment, exactly like a busy runtime. The stale
          // draft is dropped before the new one is built.
          if (isRevisionConflict(error)) {
            busy = true;
            if (previewId !== null) host.discard(previewId, owner);
            previewId = null;
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
        if (settled && jobState(applied.id, owner) === 'succeeded')
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

    entry.done = runPackageJob(entry, signal, {
      previewId: request.previewId,
      entry: request.entry,
      acknowledgedWarnings: request.acknowledgedWarnings,
      save: (provenance) => savePackageConnector(provenance),
      cleanup: () => {
        blank(env);
        blank(request.env);
        blank(rawEnv);
      },
    });

    return snapshot(entry);
  };

  const replace = async (raw: unknown, owner: string): Promise<PackageJob> => {
    if (closed)
      throw new HubError('unavailable', 'Managed packages are not available.');
    const request = PackageReplaceRequestSchema.parse(raw);
    // The replace shares the single install slot with the install: the slot
    // is taken before the first await, so two installs never pass the check.
    if (installs >= MAX_INSTALLS)
      throw new HubError('busy', 'A package install is already running.');
    installs += 1;
    try {
      const state = await host.inventory();
      const connector = state.connectors.find(
        (item) => item.id === request.connectorId,
      );
      if (!connector) throw new HubError('not_found', 'Connector not found.');
      if (connector.executionMode !== 'native' || !connector.package)
        throw new HubError(
          'invalid',
          'This connector is not a managed package.',
        );
      if (connector.revision !== request.expectedConnectorRevision)
        throw new HubError(
          'conflict',
          'Definition changed. Preview the replacement again.',
        );
      // A preview that is gone is not refused here: the job reports
      // preview_expired. A preview of another package never runs.
      const preview = previews.peek(request.previewId, owner);
      if (preview && preview.name !== connector.package.name)
        throw new HubError(
          'invalid',
          'The preview is for a different package.',
        );
      reserve();
    } catch (error) {
      installs -= 1;
      throw error;
    }

    const entry = createJob('replace', 'queued', owner);
    const signal = AbortSignal.any([
      entry.controller.signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);

    // The internal save of the replacement. It runs under the package lock,
    // because the installer calls it there: the marker is gone and the folder
    // is published, so the state write belongs to the same critical section.
    // There are no credential writes: the bindings, the environment, the user
    // arguments and the profile membership stay as they are.
    const savePackageReplace = async (
      provenance: PackageProvenance,
    ): Promise<SaveOutcome> => {
      let busy = false;
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
        let applied: Job;
        try {
          applied = await host.replacePackage(
            {
              connectorId: request.connectorId,
              expectedConnectorRevision: request.expectedConnectorRevision,
              package: provenance,
              nodeExecutable: adapter.nodeExecutable,
              packagesDir: adapter.packagesDir,
            },
            owner,
          );
        } catch (error) {
          // A busy mutation committed nothing: the replacement is tried again.
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
        if (settled && jobState(applied.id, owner) === 'succeeded')
          return {
            status: 'committed',
            connectorId: request.connectorId,
            outcome: 'saved',
          };
        // The mutation did not succeed. The registry decides whether the
        // connector carries the new install: a write that may have committed
        // is uncertain.
        let current: HubState;
        try {
          current = await host.inventory();
        } catch {
          return { status: 'indeterminate' };
        }
        const stored = current.connectors.find(
          (item) => item.id === request.connectorId,
        );
        if (!stored)
          return { status: 'not_committed', error: 'install_failed' };
        if (
          stored.executionMode === 'native' &&
          stored.package?.installId === provenance.installId
        )
          return {
            status: 'committed',
            connectorId: request.connectorId,
            outcome: 'saved',
          };
        // The connector still carries its old install: the new folder is
        // deleted and the old one stays.
        return { status: 'not_committed', error: 'install_failed' };
      }
      return {
        status: 'not_committed',
        error: busy ? 'busy' : 'install_failed',
      };
    };

    entry.done = runPackageJob(entry, signal, {
      previewId: request.previewId,
      entry: request.entry,
      acknowledgedWarnings: request.acknowledgedWarnings,
      save: (provenance) => savePackageReplace(provenance),
      // The old folder is unreferenced now. It is removed after the install
      // returned, never from inside the save that runs under the lock.
      afterSave: () => {
        void reconcile().catch(() => undefined);
      },
    });

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
    // The folder of the self-test is kept while the test runs.
    if (selfTestJobId !== null) active.add(selfTestJobId);
    return active;
  };

  // The reconciliation of the package folders. One pass runs at a time. A
  // call that arrives while a pass runs gets one follow-up pass, shared by
  // every such call: the running pass may have read the registry before the
  // change that asked for it, so it is never reused. A failure rejects and
  // nothing is deleted without a state read.
  type ReconcileCounts = { deleted: number; retained: number };
  let reconciling: Promise<ReconcileCounts> | null = null;
  let followUp: Promise<ReconcileCounts> | null = null;
  const pass = async (): Promise<ReconcileCounts> => {
    const result = await reconcilePackages({
      packagesDir: adapter.packagesDir,
      readState: () => host.inventory(),
      activeJobs,
      lock,
    });
    // Only the counts leave the service: never a folder id and never a path.
    return {
      deleted: result.deleted.length,
      retained: result.retained.length,
    };
  };
  const reconcile = (): Promise<ReconcileCounts> => {
    if (closed && !reconciling)
      return Promise.resolve({ deleted: 0, retained: 0 });
    if (!reconciling) {
      const running: Promise<ReconcileCounts> = pass().finally(() => {
        if (reconciling === running) reconciling = null;
      });
      reconciling = running;
      return running;
    }
    if (!followUp) {
      const queued: Promise<ReconcileCounts> = reconciling
        .catch(() => undefined)
        .then(() => {
          if (followUp === queued) followUp = null;
          return reconcile();
        });
      followUp = queued;
    }
    return followUp;
  };

  // The startup reconciliation: a restart removes the orphans of a crash.
  const startup = reconcile();
  void startup.catch(() => undefined);

  const close = async (): Promise<void> => {
    closed = true;
    for (const entry of records.values()) {
      if (entry.job.completedAt) continue;
      // A committing job finishes on its own: its outcome is the truth.
      if (entry.commitState === 'committing') continue;
      entry.controller.abort();
    }
    await Promise.allSettled([...records.values()].map((entry) => entry.done));
    // The self-test and its job folder are gone before the service ends.
    selfTestController.abort();
    await selfTestPromise?.catch(() => undefined);
    await previews.dispose();
    // The reconciliation of the startup and a running one finish before the
    // service ends.
    await startup.catch(() => undefined);
    while (reconciling || followUp)
      await (followUp ?? reconciling)!.catch(() => undefined);
  };

  return {
    resolve,
    install,
    replace,
    job,
    cancel,
    verify,
    reconcile,
    activeJobs,
    lock,
    close,
  };
}
