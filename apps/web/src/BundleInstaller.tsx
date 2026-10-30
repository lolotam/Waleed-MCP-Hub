import { useEffect, useRef, useState } from 'react';
import { MCPB_MAX_ARCHIVE_BYTES, type McpbPreview } from '@waleed/contracts';
import { api, uploadBundle } from './api.js';

export function BundleInstaller({
  revision,
  refresh,
  onBusy,
  disabled = false,
}: {
  revision: number;
  refresh: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const area = useRef<HTMLFieldSetElement>(null),
    previewId = useRef<string | null>(null),
    mounted = useRef(true);
  const [preview, setPreview] = useState<McpbPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [consent, setConsent] = useState(false);
  const clear = () => {
    area.current
      ?.querySelectorAll<HTMLInputElement>('[data-config]')
      .forEach((input) => {
        input.value = '';
        input.checked = false;
      });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clear();
      const id = previewId.current;
      previewId.current = null;
      if (id) void api(`/api/bundles/${id}/cancel`, {}).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(
      () => {
        clear();
        previewId.current = null;
        setPreview(null);
        setConsent(false);
        setError('Bundle preview expired. Choose the bundle again.');
        void api(`/api/bundles/${preview.id}/cancel`, {}).catch(
          () => undefined,
        );
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preview]);
  const working = (value: boolean) => {
    setBusy(value);
    onBusy(value);
  };
  async function discard() {
    const id = previewId.current;
    previewId.current = null;
    clear();
    setPreview(null);
    setConsent(false);
    if (id) await api(`/api/bundles/${id}/cancel`, {}).catch(() => undefined);
  }
  async function inspect(file: File | undefined) {
    if (!file || busy || disabled) return;
    setError('');
    setNotice('');
    if (
      !file.name.toLowerCase().endsWith('.mcpb') ||
      file.size > MCPB_MAX_ARCHIVE_BYTES ||
      !file.size
    ) {
      setError('Choose a nonempty .mcpb file of at most 25 MiB.');
      return;
    }
    working(true);
    try {
      await discard();
      const result = await uploadBundle(file);
      if (!mounted.current) {
        await api(`/api/bundles/${result.id}/cancel`, {});
        return;
      }
      previewId.current = result.id;
      setPreview(result);
    } catch {
      setError(
        'Bundle review failed. Unsupported manifests, unsafe paths and oversized archives are refused.',
      );
    } finally {
      working(false);
    }
  }
  async function install() {
    if (!preview || !consent || busy || disabled) return;
    if (
      !area.current?.querySelectorAll<HTMLInputElement>('[data-config]') ||
      !Array.from(
        area.current.querySelectorAll<HTMLInputElement>('[data-config]'),
      ).every((input) => input.reportValidity())
    )
      return;
    const configuration: Record<string, string | number | boolean> =
      Object.create(null) as Record<string, string | number | boolean>;
    for (const input of area.current.querySelectorAll<HTMLInputElement>(
      '[data-config]',
    )) {
      if (input.type === 'checkbox')
        configuration[input.dataset.config!] = input.checked;
      else if (input.value !== '')
        configuration[input.dataset.config!] =
          fields[input.dataset.config!]!.type === 'number'
            ? Number(input.value)
            : input.value;
    }
    working(true);
    setError('');
    const id = preview.id;
    previewId.current = null;
    try {
      const result = await api<{ state: string; recoveryRequired?: boolean }>(
        `/api/bundles/${id}/install`,
        { expectedRevision: revision, configuration, confirmInstall: true },
      );
      clear();
      setPreview(null);
      setConsent(false);
      setNotice(
        result.recoveryRequired
          ? 'Bundle saved; recovery review is required. Do not reinstall.'
          : 'Bundle installed. Execution is not approved. Review and approve the connector before testing or connecting an agent.',
      );
      await refresh();
    } catch {
      clear();
      setPreview(null);
      setConsent(false);
      setError(
        'Installation did not complete normally. Inspect inventory and recovery before uploading again.',
      );
    } finally {
      for (const key of Object.keys(configuration)) configuration[key] = '';
      working(false);
    }
  }
  const fields =
    preview?.manifest.user_config ?? preview?.manifest.configuration ?? {};
  return (
    <details className="review">
      <summary>Install a .mcpb bundle</summary>
      <fieldset
        ref={area}
        disabled={busy || disabled}
        onChange={(event) => {
          if (
            event.target instanceof HTMLInputElement &&
            event.target.dataset.config
          )
            setConsent(false);
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            event.target instanceof HTMLInputElement &&
            event.target.type !== 'file'
          )
            event.preventDefault();
        }}
      >
        <legend>Bundle review and installation</legend>
        <div
          className="bundle-drop"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (event.dataTransfer.files.length !== 1) {
              setError('Choose one bundle at a time.');
              return;
            }
            void inspect(event.dataTransfer.files[0]);
          }}
        >
          <label>
            Choose .mcpb bundle
            <input
              type="file"
              accept=".mcpb"
              onChange={(event) => {
                void inspect(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          <p>
            Or drop one .mcpb here. Up to 25 MiB compressed, 50 MiB extracted
            and 500 entries. Preview runs no code.
          </p>
        </div>
        {preview && (
          <>
            <section aria-label="Bundle metadata">
              <h3>{preview.manifest.display_name ?? preview.manifest.name}</h3>
              <p>{preview.manifest.description}</p>
              <p>
                Version {preview.manifest.version} · Author:{' '}
                {preview.manifest.author.name} · Runtime:{' '}
                {preview.manifest.server.type}
              </p>
              <p>
                {preview.fileCount} files ·{' '}
                {preview.uncompressedBytes.toLocaleString()} bytes extracted
              </p>
              <p>
                Entry point: <code>{preview.manifest.server.entry_point}</code>
              </p>
              <p>
                Untrusted bundle. Author details are self-reported, not a
                verified signature. No dependency installation or bundled setup
                scripts will run.
              </p>
            </section>
            <div className="form-fields">
              {Object.entries(fields).map(([key, field]) => (
                <div key={key}>
                  <label>
                    {field.title}
                    {field.required ? ' (required)' : ''}
                    {field.secret || field.sensitive ? ' · protected' : ''}
                    <input
                      data-config={key}
                      inputMode={
                        field.type === 'number' ? 'decimal' : undefined
                      }
                      type={
                        field.type === 'boolean'
                          ? 'checkbox'
                          : field.secret || field.sensitive
                            ? 'password'
                            : field.type === 'number'
                              ? 'number'
                              : 'text'
                      }
                      required={
                        field.type !== 'boolean' && field.required === true
                      }
                      defaultChecked={
                        field.type === 'boolean' && field.default === true
                      }
                      defaultValue={
                        field.type === 'boolean'
                          ? undefined
                          : String(field.default ?? '')
                      }
                      min={field.min}
                      max={field.max}
                      step={field.type === 'number' ? 'any' : undefined}
                      maxLength={8192}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={`bundle-field-${key}`}
                    />
                  </label>
                  <small id={`bundle-field-${key}`}>
                    {field.description ?? `${field.type} value`}
                    {field.type === 'directory' || field.type === 'file'
                      ? ' — absolute Windows path; no file contents are uploaded.'
                      : ''}
                  </small>
                </div>
              ))}
            </div>
            <p>
              Environment configuration is stored only in the DPAPI vault.
              Protected values are never added to command arguments.
            </p>
            <label className="import-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              I confirm installing this reviewed bundle and its protected
              configuration. This does not approve execution.
            </label>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={!consent}
                onClick={() => void install()}
              >
                Install reviewed bundle
              </button>
              <button type="button" onClick={() => void discard()}>
                Discard bundle preview
              </button>
            </div>
          </>
        )}
      </fieldset>
      {busy && <p role="status">Processing bundle…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
