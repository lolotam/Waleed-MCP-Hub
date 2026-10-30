import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ExportSetupBundleSchema,
  ImportSetupPreviewSchema,
  SETUP_MAX_BYTES,
  type ImportSetupPreview,
  type SetupConflictStrategy,
} from '@waleed/contracts';
import { api } from './api.js';

export function SetupSettings({
  blocked,
  revision,
  refresh,
}: {
  blocked: boolean;
  revision: number;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [preview, setPreview] = useState<ImportSetupPreview | null>(null),
    [strategy, setStrategy] = useState<SetupConflictStrategy>('skip_existing'),
    [consent, setConsent] = useState(false);
  const source = useRef(''),
    fileInput = useRef<HTMLInputElement>(null),
    form = useRef<HTMLFormElement>(null),
    active = useRef(true),
    previewRef = useRef<ImportSetupPreview | null>(null),
    pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      source.current = '';
      form.current?.reset();
      const id = previewRef.current?.id;
      if (id)
        void api(`/api/setup/import/${id}/cancel`, {}).catch(() => undefined);
    };
  }, []);
  const stale =
    !!preview &&
    (preview.expectedRevision !== revision ||
      Date.parse(preview.expiresAt) <= Date.now());
  async function clear() {
    form.current?.reset();
    setConsent(false);
    setPreview(null);
    const id = previewRef.current?.id;
    previewRef.current = null;
    if (id)
      await api(`/api/setup/import/${id}/cancel`, {}).catch(() => undefined);
  }
  async function review(text: string, nextStrategy: SetupConflictStrategy) {
    await clear();
    const result = ImportSetupPreviewSchema.parse(
      await api('/api/setup/import/preview', {
        source: text,
        conflictStrategy: nextStrategy,
      }),
    );
    if (active.current) {
      previewRef.current = result;
      setPreview(result);
    } else
      await api(`/api/setup/import/${result.id}/cancel`, {}).catch(
        () => undefined,
      );
  }
  async function upload(file: File | undefined) {
    if (!file || pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    source.current = '';
    try {
      if (file.size > SETUP_MAX_BYTES || file.size === 0) throw new Error();
      const text = await file.text();
      await review(text, strategy);
      if (active.current) source.current = text;
    } catch {
      await clear();
      setError(
        'Setup could not be reviewed. Use a secret-free version 1 JSON file up to 512 KiB, without unsafe paths, commands or conflicting names.',
      );
    } finally {
      if (fileInput.current) fileInput.current.value = '';
      pending.current = false;
      setBusy(false);
    }
  }
  async function changeStrategy(next: SetupConflictStrategy) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setStrategy(next);
    try {
      if (source.current) await review(source.current, next);
    } catch {
      setError(
        'Preview could not be refreshed. Upload and review the setup again.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function download() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const bundle = ExportSetupBundleSchema.parse(
          await api('/api/setup/export'),
        ),
        blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' }),
        url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = 'setup.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        'Secret-free setup.json downloaded. Local installation files and execution approval are not included.',
      );
    } catch {
      setError(
        'Export refused: unlock the protected vault and remove embedded credentials or unsupported configuration values. No setup was downloaded.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function apply(event: FormEvent) {
    event.preventDefault();
    if (!preview || stale || !consent || pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const credentials: Record<string, string> = {},
      data = new FormData(form.current!);
    for (const field of preview.missingSecrets)
      credentials[field.inputKey] = String(data.get(field.inputKey) ?? '');
    form.current?.reset();
    const selected = preview;
    setPreview(null);
    previewRef.current = null;
    source.current = '';
    setConsent(false);
    let saved = false;
    try {
      const result = await api<{ state: string; recoveryRequired: boolean }>(
        '/api/setup/import/apply',
        {
          previewId: selected.id,
          expectedRevision: selected.expectedRevision,
          conflictStrategy: selected.conflictStrategy,
          credentials,
        },
      );
      saved = true;
      await refresh();
      setNotice(
        result.recoveryRequired
          ? 'Setup saved. Recovery review is required before further changes.'
          : 'Setup imported. Credentials protected; review and approve each imported connector before running it.',
      );
    } catch {
      setError(
        saved
          ? 'Setup saved, but refresh failed. Refresh inventory before another change.'
          : 'Setup import was not confirmed. Inspect inventory and recovery before uploading a new preview. Credentials have been cleared.',
      );
      await refresh().catch(() => undefined);
    } finally {
      for (const key of Object.keys(credentials)) credentials[key] = '';
      for (const key of data.keys()) data.delete(key);
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="list-panel integration-guidance setup-settings"
      aria-labelledby="setup-title"
    >
      <h2 id="setup-title">Share & restore setups</h2>
      <p className="security-banner">
        <strong>Exported configs contain zero secrets</strong>
        <br />
        Credentials become required fields. Approval, OAuth accounts, DPAPI data
        and local installation files never travel.
      </p>
      <p className="muted">
        Docker-vault credentials cannot be converted to native vault bindings:
        import Docker definitions without credential placeholders, then bind
        Docker credentials separately. Export refuses unreadable protected
        credentials or embedded secrets.
      </p>
      <button
        type="button"
        disabled={busy || blocked}
        onClick={() => void download()}
      >
        Export Configuration
      </button>
      <div
        className="setup-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files.length === 1)
            void upload(event.dataTransfer.files[0]);
        }}
      >
        <label htmlFor="setup-file">Import Configuration</label>
        <p className="muted">
          Drop one setup.json here, or choose a file. Maximum 512 KiB. Treat
          shared commands and tool metadata as untrusted.
        </p>
        <input
          ref={fileInput}
          id="setup-file"
          type="file"
          accept="application/json,.json"
          disabled={busy || blocked}
          onChange={(event) => void upload(event.target.files?.[0])}
        />
      </div>
      <label htmlFor="setup-strategy">When an identifier already exists</label>
      <select
        id="setup-strategy"
        value={strategy}
        disabled={busy || blocked}
        onChange={(event) =>
          void changeStrategy(event.target.value as SetupConflictStrategy)
        }
      >
        <option value="skip_existing">
          Skip existing — preserve local entries
        </option>
        <option value="overwrite_existing">
          Overwrite existing — replace matching IDs
        </option>
      </select>
      {preview && (
        <form
          ref={form}
          autoComplete="off"
          onSubmit={(event) => void apply(event)}
        >
          <h3>Review setup</h3>
          <p>
            {preview.connectors.length} connectors · {preview.profiles.length}{' '}
            profiles · {preview.collisions.length} ID collisions
          </p>
          <div className="setup-summary">
            {(['connectors', 'profiles'] as const).map((kind) => (
              <div key={kind}>
                <h4>{kind === 'connectors' ? 'Connectors' : 'Profiles'}</h4>
                <ul>
                  {preview[kind].map((item) => (
                    <li key={item.id}>
                      <strong>{item.name}</strong> <code>{item.id}</code>
                      <span className="pill">{item.action}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <details>
            <summary>
              Review commands, policies, overrides & agent assignments
            </summary>
            <pre className="setup-definition">
              {JSON.stringify(preview.bundle, null, 2)}
            </pre>
          </details>
          <ul className="muted">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <h3>Required credentials ({preview.missingSecrets.length})</h3>
          <p className="muted">
            Written directly to the native credential vault. Never saved in
            browser storage or in the setup file. OAuth access tokens can be
            replaced with a fresh OAuth connection after import.
          </p>
          {preview.missingSecrets.map((field, index) => (
            <div className="form-fields" key={field.inputKey}>
              <label htmlFor={`setup-secret-${index}`}>
                {field.connectorId} · {field.key} ({field.target},{' '}
                {field.format})
              </label>
              {field.description && (
                <small className="muted">{field.description}</small>
              )}
              <input
                id={`setup-secret-${index}`}
                name={field.inputKey}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                required
                maxLength={8192}
                disabled={busy || blocked || stale}
              />
            </div>
          ))}
          <label className="import-check">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy || blocked || stale}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I reviewed this setup, its commands, policies and agent assignments.
          </label>
          {stale && (
            <p role="alert">
              Preview expired or inventory changed. Upload and review the setup
              again.
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                source.current = '';
                void clear();
              }}
            >
              Discard preview
            </button>
            <button
              className="primary"
              type="submit"
              disabled={busy || blocked || stale || !consent}
            >
              Apply Setup
            </button>
          </div>
        </form>
      )}
      {busy && <p role="status">Processing setup…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
