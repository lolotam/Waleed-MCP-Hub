import { useEffect, useRef, useState } from 'react';
import {
  PackageInstallRequestSchema,
  PackageJobSchema,
  PackageResolveRequestSchema,
  type PackageErrorCode,
  type PackageJob,
  type PackagePreview,
  type PackageWarning,
} from '@waleed/contracts';
import {
  api,
  ApiError,
  packageErrorText,
  packageFailureText,
  packageWarningText,
  pollPackageJob,
} from './api.js';
import { Icon } from './Icon.js';
import type { ManagedPackageConnector } from './ConnectorList.js';

export type PackageSeed =
  | {
      mode: 'install';
      name?: string;
      // The metadata of an imported connector. The connector name of the form
      // is the name of the connector, not the name of the package.
      connectorName?: string;
      connectorId?: string;
      description?: string;
      entry?: string;
      enabled?: boolean;
      environmentLiterals?: Record<string, string>;
      version?: string;
      arguments?: string[];
      envNames?: string[];
    }
  | {
      mode: 'replace';
      connector: ManagedPackageConnector;
      version?: string;
      purpose: 'update' | 'reinstall' | 'change';
    };

type Step = 'lookup' | 'resolving' | 'preview' | 'installing' | 'result';

// The client never learns a real install path, so the preview shows a
// placeholder instead of a folder of the user profile.
const INSTALL_FOLDER = '<install folder>';

function parseJsonField(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

// The codes of a 503 the hub sends before it creates any job: managed
// packages are off, or the refusal could not be audited. Any other 503 may
// follow a job, so it leaves the outcome unknown.
const PRE_START_REFUSALS = new Set(['unavailable', 'audit_unavailable']);
// The longest wait on the connector list reload after a package outcome.
const RELOAD_LIMIT_MS = 15_000;

export function PackageInstall({
  seed,
  close,
  refresh,
  onRunning,
  showCancel = true,
}: {
  seed: PackageSeed;
  close: () => void;
  refresh: () => Promise<boolean>;
  onRunning?: (running: boolean) => void;
  showCancel?: boolean;
}) {
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [step, setStep] = useState<Step>('lookup');
  const [connectorName, setConnectorName] = useState(
    seed.mode === 'install'
      ? (seed.connectorName ?? seed.name ?? '')
      : seed.connector.name,
  );
  const [packageName, setPackageName] = useState(
    seed.mode === 'install'
      ? (seed.name ?? '')
      : (seed.connector.package.name ?? ''),
  );
  const currentSource =
    seed.mode === 'replace' ? seed.connector.package.source : undefined;
  const [sourceKind, setSourceKind] = useState(
    currentSource ? 'github' : 'npm',
  );
  const [repository, setRepository] = useState(currentSource?.repository ?? '');
  const [tag, setTag] = useState(currentSource?.tag ?? '');
  const [assetName, setAssetName] = useState(currentSource?.assetName ?? '');
  const [sha256, setSha256] = useState(currentSource?.sha256 ?? '');
  const [version, setVersion] = useState(
    seed.version ??
      (currentSource && seed.mode === 'replace'
        ? seed.connector.package.version
        : ''),
  );
  const [job, setJob] = useState<PackageJob | null>(null);
  const [preview, setPreview] = useState<PackagePreview | null>(null);
  const [entry, setEntry] = useState('');
  const [acknowledged, setAcknowledged] = useState<PackageWarning[]>([]);
  const [nameChangeAcknowledged, setNameChangeAcknowledged] = useState(false);
  const [sourceAcknowledged, setSourceAcknowledged] = useState(false);
  const changesSource =
    seed.mode === 'replace' &&
    !!preview &&
    JSON.stringify(currentSource ?? null) !==
      JSON.stringify(preview.source ?? null);
  const changesPackageName =
    seed.mode === 'replace' &&
    !!preview &&
    preview.name !== seed.connector.package.name;
  const [argumentsText, setArgumentsText] = useState(
    JSON.stringify(seed.mode === 'install' ? (seed.arguments ?? []) : []),
  );
  // Protected values stay in the uncontrolled field only, never in React
  // state, and are cleared on every error, submission and close.
  const env = useRef<HTMLTextAreaElement>(null);
  const clearEnv = () => {
    if (env.current) env.current.value = '';
  };
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failureCode, setFailureCode] = useState<PackageErrorCode | null>(null);
  // An accepted job whose progress could not be read.
  const [unknownJob, setUnknownJob] = useState<{
    job: PackageJob;
    label: string;
  } | null>(null);
  // The attempt that owns the view. A reload of an older attempt that settles
  // late never overwrites a newer attempt's outcome.
  const attempt = useRef(0);
  const running = step === 'resolving' || step === 'installing';
  const reportRunning = useRef(onRunning);
  reportRunning.current = onRunning;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
      // The parent never stays locked by a flow that is gone.
      reportRunning.current?.(false);
      // A protected value never outlives the view that asked for it.
      clearEnv();
    };
  }, []);
  useEffect(() => {
    onRunning?.(running);
  }, [running, onRunning]);

  function dismiss() {
    clearEnv();
    close();
  }

  async function cancelJob() {
    if (!job) return;
    try {
      const next = PackageJobSchema.parse(
        await api<PackageJob>(`/api/packages/jobs/${job.id}/cancel`, {}),
      );
      if (mounted.current) setJob(next);
    } catch {
      if (mounted.current) setError('Cancellation could not be confirmed.');
    }
  }

  async function lookUp() {
    setNameChangeAcknowledged(false);
    setSourceAcknowledged(false);
    setError('');
    setNotice('');
    setFailureCode(null);
    const request = PackageResolveRequestSchema.safeParse({
      name: packageName.trim(),
      ...(sourceKind === 'github'
        ? {
            source: {
              kind: 'github-release',
              repository,
              tag,
              assetName,
              sha256,
            },
          }
        : {}),
      ...(version.trim() ? { version: version.trim() } : {}),
    });
    if (!request.success) {
      setError(request.error.issues[0]?.message ?? 'Enter a package name.');
      return;
    }
    // The name is asked here: the preview step has no field for it.
    if (seed.mode === 'install' && !connectorName.trim()) {
      setError('Enter a connector name.');
      return;
    }
    // Cancel never targets the job of an earlier step.
    setJob(null);
    setStep('resolving');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const started = PackageJobSchema.parse(
        await api<PackageJob>('/api/packages/resolve', request.data),
      );
      if (!mounted.current) return;
      setJob(started);
      const final = await pollPackageJob(
        started,
        (next) => {
          if (mounted.current) setJob(next);
        },
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (final.state === 'succeeded' && final.preview) {
        // A warning is ticked once, even if the hub listed it twice.
        setPreview({
          ...final.preview,
          warnings: [...new Set(final.preview.warnings)],
        });
        setAcknowledged([]);
        setEntry(
          final.preview.entries.length === 1
            ? final.preview.entries[0]!.entry
            : seed.mode === 'replace'
              ? (seed.connector.package.entry ?? '')
              : seed.entry &&
                  final.preview.entries.some(
                    (item) => item.entry === seed.entry,
                  )
                ? seed.entry
                : '',
        );
        setFailureCode(null);
        setStep('preview');
        return;
      }
      setFailureCode(final.error);
      setError(packageErrorText(final.error ?? 'install_failed'));
      setStep('lookup');
    } catch (failure) {
      if (!mounted.current) return;
      setError(packageFailureText(failure));
      setStep('lookup');
    } finally {
      abort.current = null;
    }
  }

  async function install() {
    setError('');
    setFailureCode(null);
    // The protected values leave the form at once: every refusal below and
    // the request itself use this copy, so the field is never left filled.
    const envText = env.current?.value ?? '';
    clearEnv();
    if (!preview) return;
    const selected = preview.entries.find((item) => item.entry === entry);
    if (!selected) {
      setError(packageErrorText('entry_required'));
      return;
    }
    if (acknowledged.length !== preview.warnings.length) {
      setError(packageErrorText('warning_not_acknowledged'));
      return;
    }
    if (changesSource && !sourceAcknowledged) {
      setError('Confirm changing the artifact source.');
      return;
    }
    if (changesPackageName && !nameChangeAcknowledged) {
      setError(
        'Confirm the change of package and publisher before continuing.',
      );
      return;
    }
    let body: Record<string, unknown>;
    if (seed.mode === 'install') {
      if (!connectorName.trim()) {
        setError('Enter a connector name.');
        return;
      }
      const argumentsField = parseJsonField(argumentsText);
      if (!argumentsField.ok) {
        setError('Use a JSON array of arguments, for example ["--stdio"].');
        return;
      }
      const argumentsResult =
        PackageInstallRequestSchema.shape.arguments.safeParse(
          argumentsField.value === undefined ? [] : argumentsField.value,
        );
      if (!argumentsResult.success) {
        setError(
          argumentsResult.error.issues[0]?.message ??
            'Use a JSON array of arguments.',
        );
        return;
      }
      const envField = parseJsonField(envText);
      if (!envField.ok) {
        setError('Use a JSON object of environment values.');
        return;
      }
      const envResult = PackageInstallRequestSchema.shape.env.safeParse(
        envField.value === undefined ? {} : envField.value,
      );
      if (!envResult.success) {
        setError(
          envResult.error.issues[0]?.message ??
            'Use a JSON object of environment values.',
        );
        return;
      }
      body = {
        previewId: preview.previewId,
        entry: selected.entry,
        acknowledgedWarnings: acknowledged,
        connectorName: connectorName.trim(),
        arguments: argumentsResult.data,
        env: envResult.data,
        // The metadata of an imported connector travels with the install; a
        // manual install keeps the defaults of the hub.
        ...(seed.connectorId ? { connectorId: seed.connectorId } : {}),
        ...(seed.description !== undefined
          ? { description: seed.description }
          : {}),
        ...(seed.enabled !== undefined ? { enabled: seed.enabled } : {}),
        ...(seed.environmentLiterals &&
        Object.keys(seed.environmentLiterals).length
          ? { environmentLiterals: seed.environmentLiterals }
          : {}),
      };
    } else {
      body = {
        connectorId: seed.connector.id,
        expectedConnectorRevision: seed.connector.revision,
        ...(changesSource
          ? {
              sourceChange: {
                from: currentSource ?? null,
                to: preview.source ?? null,
              },
            }
          : {}),
        previewId: preview.previewId,
        entry: selected.entry,
        acknowledgedWarnings: acknowledged,
        ...(changesPackageName
          ? {
              packageNameChange: {
                from: seed.connector.package.name,
                to: preview.name,
              },
            }
          : {}),
      };
    }
    // The request object is blanked again when it settles.
    setJob(null);
    setUnknownJob(null);
    setStep('installing');
    const controller = new AbortController();
    abort.current = controller;
    const label = `${preview.name}@${preview.version}`;
    // Until the hub answered, its job may exist: only a refusal of the hub (a
    // 4xx answer, or a 503 with its code) proves that nothing started, so
    // every other failure leaves the outcome unknown and never offers a retry
    // against the old state.
    let started: PackageJob | null = null;
    try {
      try {
        started = PackageJobSchema.parse(
          await api<PackageJob>(
            seed.mode === 'install'
              ? '/api/packages/install'
              : '/api/packages/replace',
            body,
          ),
        );
      } catch (failure) {
        if (
          failure instanceof ApiError &&
          ((failure.status >= 400 && failure.status < 500) ||
            (failure.status === 503 &&
              PRE_START_REFUSALS.has(failure.code ?? '')))
        ) {
          if (!mounted.current) return;
          setError(packageFailureText(failure));
          setStep('lookup');
          return;
        }
        throw failure;
      }
      if (!mounted.current) return;
      await follow(started, controller.signal, label);
    } catch (failure) {
      if (!mounted.current) return;
      await unknownOutcome(started, label, failure);
    } finally {
      const values = body.env as Record<string, string> | undefined;
      if (values) for (const key of Object.keys(values)) values[key] = '';
      if (abort.current === controller) abort.current = null;
    }
  }

  // The connector list is reloaded after every outcome. A failed or stalled
  // reload never decides that outcome: it only adds that the list is stale,
  // and it ends within a bounded time so the call always reaches its cleanup.
  async function reload(): Promise<string> {
    const stale =
      ' The connector list could not be reloaded; reload the page to see it.';
    let timer = 0;
    try {
      const settled = await Promise.race([
        refresh(),
        new Promise<false>((resolve) => {
          timer = window.setTimeout(() => resolve(false), RELOAD_LIMIT_MS);
        }),
      ]);
      return settled ? '' : stale;
    } catch {
      return stale;
    } finally {
      window.clearTimeout(timer);
    }
  }

  // Follows an accepted job to its end. Only a failed poll throws.
  async function follow(
    started: PackageJob,
    signal: AbortSignal,
    label: string,
  ) {
    setJob(started);
    const final = await pollPackageJob(
      started,
      (next) => {
        if (mounted.current) setJob(next);
      },
      signal,
    );
    if (!mounted.current || signal.aborted) return;
    setUnknownJob(null);
    if (final.state === 'succeeded' && final.result) {
      const saved = final.result.outcome === 'saved';
      setNotice(
        seed.mode === 'install'
          ? saved
            ? `Installed ${label} as connector ${final.result.connectorId}. Saving is not approval: approve its exact definition in the connector list before it can run.`
            : `Installed ${label} as connector ${final.result.connectorId}, but not every step was saved. Review the connector before use.`
          : saved
            ? `Replaced with ${label}. The new definition needs approval again.`
            : `Replaced with ${label}, but not every step was saved. Review the connector before use.`,
      );
      setFailureCode(null);
      setError('');
      setStep('result');
      const stale = await reload();
      if (stale && mounted.current) setError(stale.trim());
      return;
    }
    setFailureCode(final.error);
    if (final.error === 'save_uncertain') {
      // The save may have landed: this view offers no retry against the old
      // state.
      setStep('result');
      const stale = await reload();
      if (mounted.current) setError(packageErrorText('save_uncertain') + stale);
      return;
    }
    setError(packageErrorText(final.error ?? 'install_failed'));
    setStep('lookup');
  }

  // The outcome of a job whose answer or progress was lost. The view keeps
  // the job, if one was read and the hub still knows it, so it can be checked
  // again. The result shows at once and nothing waits on the reload: a later
  // attempt owns the view, so this reload's late sentence is then dropped.
  async function unknownOutcome(
    started: PackageJob | null,
    label: string,
    failure: unknown,
  ) {
    const forgotten = failure instanceof ApiError && failure.status === 404;
    const text = !started
      ? 'The hub may have started the job, but its answer was lost, so the outcome is unknown. Wait a moment, then check the connector list before installing again.'
      : forgotten
        ? 'The hub no longer knows this job (it may have restarted), so its outcome is unknown. Check the connector list before installing again.'
        : 'The job was started but its progress could not be read, so its outcome is unknown. It may still be running: check the job again, or check the connector list before installing again.';
    const owner = attempt.current;
    setUnknownJob(started && !forgotten ? { job: started, label } : null);
    setStep('result');
    setError(text);
    const stale = await reload();
    if (!mounted.current || attempt.current !== owner) return;
    if (stale) setError(text + stale);
  }

  async function checkAgain() {
    if (!unknownJob) return;
    attempt.current += 1;
    const { job: started, label } = unknownJob;
    setError('');
    setStep('installing');
    const controller = new AbortController();
    abort.current = controller;
    try {
      await follow(started, controller.signal, label);
    } catch (failure) {
      if (mounted.current) await unknownOutcome(started, label, failure);
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }

  const chosen = preview?.entries.find((item) => item.entry === entry);
  const entryPath = chosen?.entryPath ?? '<entry>';
  const parsedArguments = parseJsonField(argumentsText);
  const shownArguments =
    seed.mode === 'install'
      ? parsedArguments.ok && Array.isArray(parsedArguments.value)
        ? (parsedArguments.value as string[])
        : []
      : seed.connector.arguments.slice(2);
  const command = [
    `node.exe --no-global-search-paths ${INSTALL_FOLDER}\\node_modules\\${preview?.name ?? ''}\\${entryPath}`,
    ...shownArguments,
  ].join(' ');
  const envNames = seed.mode === 'install' ? (seed.envNames ?? []) : [];
  const literals =
    seed.mode === 'install' ? (seed.environmentLiterals ?? {}) : {};
  const ready =
    !!preview &&
    entry !== '' &&
    acknowledged.length === preview.warnings.length &&
    (!changesPackageName || nameChangeAcknowledged) &&
    (!changesSource || sourceAcknowledged);

  return (
    <div className="package-flow">
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {failureCode === 'preview_expired' && (
        <button
          type="button"
          onClick={() => {
            setError('');
            setFailureCode(null);
            setStep('lookup');
          }}
        >
          Look up again
        </button>
      )}

      {step === 'lookup' && (
        <section className="package-lookup">
          <h3>Look up</h3>
          <label htmlFor="package-source">Package source</label>
          <select
            id="package-source"
            value={sourceKind}
            onChange={(event) => setSourceKind(event.target.value)}
          >
            <option value="npm">npm registry</option>
            <option value="github">GitHub Release</option>
          </select>
          {sourceKind === 'github' && (
            <div className="form-fields">
              <p>
                Public release asset only. Exact package version and SHA256
                required. Dependencies still come from npm; no account is
                needed.
              </p>
              <label htmlFor="artifact-repository">GitHub repository</label>
              <input
                id="artifact-repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="owner/repository"
              />
              <label htmlFor="artifact-tag">Release tag</label>
              <input
                id="artifact-tag"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
              />
              <label htmlFor="artifact-name">Asset name (.tgz)</label>
              <input
                id="artifact-name"
                value={assetName}
                onChange={(event) => setAssetName(event.target.value)}
              />
              <label htmlFor="artifact-sha256">Expected SHA256</label>
              <input
                id="artifact-sha256"
                value={sha256}
                onChange={(event) => setSha256(event.target.value)}
                maxLength={64}
                spellCheck={false}
              />
            </div>
          )}
          {seed.mode === 'install' ? (
            <div className="form-fields">
              <label htmlFor="package-connector-name">Connector name</label>
              <input
                id="package-connector-name"
                value={connectorName}
                onChange={(event) => setConnectorName(event.target.value)}
                required
                maxLength={100}
              />
              <label htmlFor="package-name">Package name</label>
              <input
                id="package-name"
                value={packageName}
                onChange={(event) => setPackageName(event.target.value)}
                spellCheck={false}
                placeholder="demo-mcp"
              />
              <label htmlFor="package-version">
                {sourceKind === 'github'
                  ? 'Exact version (required)'
                  : 'Version (optional)'}
              </label>
              <input
                id="package-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                spellCheck={false}
                placeholder="latest, 1.2.3, ^1.2.0 or next"
              />
              <small>
                {sourceKind === 'github'
                  ? 'An exact package version is required for a GitHub archive.'
                  : 'The exact release, a range or a dist-tag. Blank means the latest release.'}{' '}
                Nothing is installed by the lookup.
              </small>
              {envNames.length > 0 && (
                <p className="notice">
                  This entry used: {envNames.join(', ')}. Enter their values
                  here.
                </p>
              )}
              {Object.keys(literals).length > 0 && (
                <p className="notice">
                  Environment literals of the import:{' '}
                  {Object.entries(literals)
                    .map(([name, value]) => `${name}=${value}`)
                    .join(', ')}
                  .
                </p>
              )}
            </div>
          ) : (
            <div className="form-fields">
              {seed.purpose !== 'reinstall' && (
                <>
                  <label htmlFor="package-name">Replacement package name</label>
                  <input
                    id="package-name"
                    value={packageName}
                    onChange={(event) => setPackageName(event.target.value)}
                    spellCheck={false}
                  />
                  <label htmlFor="package-version">Replacement version</label>
                  <input
                    id="package-version"
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                    spellCheck={false}
                  />
                </>
              )}
              <dl className="package-facts">
                <div>
                  <dt>Current package</dt>
                  <dd>{seed.connector.package.name}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>{version.trim() || 'latest'}</dd>
                </div>
                <div>
                  <dt>Purpose</dt>
                  <dd>
                    {seed.purpose === 'change'
                      ? 'Change package'
                      : seed.purpose === 'update'
                        ? 'Update'
                        : 'Reinstall'}
                  </dd>
                </div>
              </dl>
              <small>
                The lookup resolves the dependency tree only. Nothing is
                installed before the preview is confirmed.
              </small>
            </div>
          )}
        </section>
      )}

      {(step === 'resolving' || step === 'installing') && (
        <section className="package-progress">
          <h3>{step === 'resolving' ? 'Resolving' : 'Installing'}</h3>
          <p role="status">
            {job
              ? `${job.phase.replaceAll('_', ' ')} · ${job.progress.packages} packages · ${(job.progress.downloadedBytes / 1048576).toFixed(1)} MB downloaded`
              : 'Starting…'}
          </p>
          {job && (step === 'resolving' || job.phase !== 'saving') && (
            <button type="button" onClick={() => void cancelJob()}>
              Cancel
            </button>
          )}
        </section>
      )}

      {step === 'preview' && preview && (
        <section className="package-preview">
          <h3>
            {preview.name}@{preview.version}
          </h3>
          {preview.source && (
            <section className="notice">
              <p>
                GitHub Release: {preview.source.repository} /{' '}
                {preview.source.tag} / {preview.source.assetName}
              </p>
              <p>
                Verified SHA256: <code>{preview.source.sha256}</code>
              </p>
              <p>
                Older Hub clients cannot read this source. Update affected
                clients and back up before installing.
              </p>
            </section>
          )}
          {changesSource && (
            <label className="import-check">
              <input
                type="checkbox"
                checked={sourceAcknowledged}
                onChange={(event) =>
                  setSourceAcknowledged(event.target.checked)
                }
              />
              I confirm changing the package source and reviewed the archive
              hash
            </label>
          )}
          <p>{preview.description || 'No description'}</p>
          <dl className="package-facts">
            <div>
              <dt>Release date</dt>
              <dd>
                {preview.releasedAt
                  ? new Date(preview.releasedAt).toLocaleDateString()
                  : 'Release date unknown'}
              </dd>
            </div>
            <div>
              <dt>Packages</dt>
              <dd>
                {preview.packageCount} packages
                {preview.bundledCount > 0
                  ? ` including ${preview.bundledCount} bundled`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>Unpacked size</dt>
              <dd>
                {preview.unpackedSize === null
                  ? 'unknown'
                  : `${(preview.unpackedSize / 1048576).toFixed(1)} MB`}
              </dd>
            </div>
            <div>
              <dt>Lock hash</dt>
              <dd>
                <code title={preview.lockHash}>
                  {preview.lockHash.slice(0, 12)}
                </code>
              </dd>
            </div>
            <div>
              <dt>Preview expires</dt>
              <dd>{new Date(preview.expiresAt).toLocaleTimeString()}</dd>
            </div>
          </dl>
          {changesPackageName && seed.mode === 'replace' && (
            <section className="notice">
              <p>
                This changes the package and publisher from{' '}
                <code>{seed.connector.package.name}</code> to{' '}
                <code>{preview.name}</code>. The connector keeps its credentials
                and profiles, but execution approval is cleared. Back up first:
                the old package folder may be removed after replacement.
              </p>
              <label className="import-check">
                <input
                  type="checkbox"
                  checked={nameChangeAcknowledged}
                  onChange={(event) =>
                    setNameChangeAcknowledged(event.target.checked)
                  }
                />
                I confirm changing the package and publisher
              </label>
            </section>
          )}
          <div className="package-command">
            <h3>Command that will run</h3>
            <code>{command}</code>
          </div>
          {preview.entries.length > 1 && (
            <fieldset className="package-entries">
              <legend>Command to run</legend>
              {preview.entries.map((item) => (
                <label key={item.entry} className="import-check">
                  <input
                    type="radio"
                    name="package-entry"
                    value={item.entry}
                    checked={entry === item.entry}
                    onChange={() => setEntry(item.entry)}
                  />
                  {item.entry} — {item.entryPath}
                </label>
              ))}
            </fieldset>
          )}
          {preview.warnings.length > 0 && (
            <fieldset className="package-warnings">
              <legend>Warnings</legend>
              {preview.warnings.map((warning) => (
                <label key={warning} className="import-check">
                  <input
                    type="checkbox"
                    checked={acknowledged.includes(warning)}
                    onChange={(event) =>
                      setAcknowledged((current) =>
                        event.target.checked
                          ? [...current, warning]
                          : current.filter((item) => item !== warning),
                      )
                    }
                  />
                  {packageWarningText(warning)}
                </label>
              ))}
            </fieldset>
          )}
          {seed.mode === 'install' && (
            <div className="form-fields">
              <label htmlFor="package-arguments">
                Arguments (JSON array, no shell expansion)
              </label>
              <textarea
                id="package-arguments"
                value={argumentsText}
                onChange={(event) => setArgumentsText(event.target.value)}
                spellCheck={false}
              />
              {envNames.length > 0 && (
                <p className="notice">
                  This entry used: {envNames.join(', ')}. Enter their values
                  here.
                </p>
              )}
              <label htmlFor="package-env">
                Protected environment values (write-only JSON)
              </label>
              <textarea
                id="package-env"
                ref={env}
                spellCheck={false}
                aria-describedby="package-env-help"
              />
              <small id="package-env-help">
                Exact values are hidden after submission and cleared on
                error/close. Names must be upper case; names starting with NODE_
                and the OpenSSL certificate variables are refused.
              </small>
            </div>
          )}
        </section>
      )}

      {step === 'result' && (
        <p className="muted">
          The connector list shows the exact definition. Approval is a separate,
          explicit action.
        </p>
      )}

      <footer className="dialog-footer package-footer">
        {step === 'result' ? (
          <>
            <button type="button" onClick={dismiss}>
              Close
            </button>
            {unknownJob && (
              <button
                className="primary"
                type="button"
                onClick={() => void checkAgain()}
              >
                Check the job again
              </button>
            )}
          </>
        ) : (
          <>
            {showCancel && (
              <button type="button" disabled={running} onClick={dismiss}>
                Cancel
              </button>
            )}
            {step === 'lookup' && (
              <button
                className="primary"
                type="button"
                disabled={running}
                onClick={() => void lookUp()}
              >
                Look up
              </button>
            )}
            {step === 'preview' && (
              <>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => {
                    setError('');
                    setFailureCode(null);
                    setPreview(null);
                    setEntry('');
                    setAcknowledged([]);
                    setStep('lookup');
                  }}
                >
                  Look up again
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={running || !ready}
                  onClick={() => void install()}
                >
                  {seed.mode === 'install' ? 'Install' : 'Replace'}
                </button>
              </>
            )}
          </>
        )}
      </footer>
    </div>
  );
}

// The dialog of the package flow: the same header and footer pattern as the
// manual dialog, a modal window and a focus restore when it closes.
export function PackageDialog({
  seed,
  close,
  refresh,
}: {
  seed: PackageSeed;
  close: () => void;
  refresh: () => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  const title =
    seed.mode === 'install'
      ? 'Install an npm package'
      : seed.purpose === 'change'
        ? 'Change an npm package'
        : seed.purpose === 'update'
          ? 'Update an npm package'
          : 'Reinstall an npm package';
  return (
    <dialog
      ref={dialog}
      className="import-dialog package-dialog"
      aria-labelledby="package-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!running) close();
      }}
    >
      <div className="dialog-header">
        <div className="eyebrow">MANAGED NPM PACKAGE</div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close package dialog"
          disabled={running}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="package-title">{title}</h2>
      <p className="muted">
        The hub resolves the dependency tree, installs it into its own folder
        and runs it with its own Node. Install scripts never run and only the
        npm registry is contacted.
      </p>
      <PackageInstall
        seed={seed}
        close={close}
        refresh={refresh}
        onRunning={setRunning}
      />
    </dialog>
  );
}
