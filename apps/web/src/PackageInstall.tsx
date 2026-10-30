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
      version?: string;
      arguments?: string[];
      envNames?: string[];
    }
  | {
      mode: 'replace';
      connector: ManagedPackageConnector;
      version?: string;
      purpose: 'update' | 'reinstall';
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

export function PackageInstall({
  seed,
  close,
  refresh,
  onRunning,
  showCancel = true,
}: {
  seed: PackageSeed;
  close: () => void;
  refresh: () => Promise<void>;
  onRunning?: (running: boolean) => void;
  showCancel?: boolean;
}) {
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [step, setStep] = useState<Step>('lookup');
  const [connectorName, setConnectorName] = useState(
    seed.mode === 'install' ? (seed.name ?? '') : seed.connector.name,
  );
  const [packageName, setPackageName] = useState(
    seed.mode === 'install'
      ? (seed.name ?? '')
      : (seed.connector.package.name ?? ''),
  );
  const [version, setVersion] = useState(seed.version ?? '');
  const [job, setJob] = useState<PackageJob | null>(null);
  const [preview, setPreview] = useState<PackagePreview | null>(null);
  const [entry, setEntry] = useState('');
  const [acknowledged, setAcknowledged] = useState<PackageWarning[]>([]);
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
    setError('');
    setNotice('');
    setFailureCode(null);
    const request = PackageResolveRequestSchema.safeParse({
      name: packageName.trim(),
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
      };
    } else {
      body = {
        connectorId: seed.connector.id,
        expectedConnectorRevision: seed.connector.revision,
        previewId: preview.previewId,
        entry: selected.entry,
        acknowledgedWarnings: acknowledged,
      };
    }
    // The request object is blanked again when it settles.
    setJob(null);
    setStep('installing');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const started = PackageJobSchema.parse(
        await api<PackageJob>(
          seed.mode === 'install'
            ? '/api/packages/install'
            : '/api/packages/replace',
          body,
        ),
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
      if (final.state === 'succeeded' && final.result) {
        const label = `${preview.name}@${preview.version}`;
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
        setStep('result');
        await refresh();
        return;
      }
      setFailureCode(final.error);
      setError(packageErrorText(final.error ?? 'install_failed'));
      if (final.error === 'save_uncertain') {
        // The save may have landed: the list is reloaded and this view
        // offers no retry against the old state.
        setStep('result');
        await refresh();
        return;
      }
      setStep('lookup');
    } catch (failure) {
      if (!mounted.current) return;
      setError(packageFailureText(failure));
      setStep('lookup');
    } finally {
      const values = body.env as Record<string, string> | undefined;
      if (values) for (const key of Object.keys(values)) values[key] = '';
      abort.current = null;
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
  const ready =
    !!preview &&
    entry !== '' &&
    acknowledged.length === preview.warnings.length;

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
              <label htmlFor="package-version">Version (optional)</label>
              <input
                id="package-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                spellCheck={false}
                placeholder="latest, 1.2.3, ^1.2.0 or next"
              />
              <small>
                The exact release, a range or a dist-tag. Blank means the latest
                release. Nothing is installed by the lookup.
              </small>
              {envNames.length > 0 && (
                <p className="notice">
                  This entry used: {envNames.join(', ')}. Enter their values
                  here.
                </p>
              )}
            </div>
          ) : (
            <div className="form-fields">
              <dl className="package-facts">
                <div>
                  <dt>Package</dt>
                  <dd>{packageName}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>{version.trim() || 'latest'}</dd>
                </div>
                <div>
                  <dt>Purpose</dt>
                  <dd>{seed.purpose === 'update' ? 'Update' : 'Reinstall'}</dd>
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
          <button type="button" onClick={dismiss}>
            Close
          </button>
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
  refresh: () => Promise<void>;
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
