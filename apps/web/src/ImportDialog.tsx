import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ImportPreview,
  ImportSelection,
  ImportDefinition,
  OperationPreview,
} from '@waleed/contracts';
import { api, ApiError } from './api.js';
import { Icon } from './Icon.js';

type Mode = 'paste' | 'endpoint' | 'native';
function sourceFromForm(form: HTMLFormElement, mode: Mode): string {
  const data = new FormData(form);
  if (mode === 'paste') return String(data.get('source') ?? '');
  const name = String(data.get('name') ?? '');
  if (mode === 'endpoint')
    return JSON.stringify({
      name,
      url: String(data.get('endpoint')),
      transport: String(data.get('transport')),
    });
  return JSON.stringify({
    name,
    command: String(data.get('executable')),
    args: JSON.parse(String(data.get('arguments') || '[]')) as unknown,
    env: JSON.parse(String(data.get('environment') || '{}')) as unknown,
  });
}

export function ImportDialog({
  revision,
  close,
  refresh,
  savePreview,
}: {
  revision: number;
  close: () => void;
  refresh: () => Promise<void>;
  savePreview: (
    preview: OperationPreview,
    definitions: ImportDefinition[],
  ) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const draftId = useRef<string | null>(null);
  const [mode, setMode] = useState<Mode>('paste');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selection, setSelection] = useState<ImportSelection['entries']>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [edited, setEdited] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    form.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    return () => {
      mounted.current = false;
      form.current?.reset();
      const id = draftId.current;
      draftId.current = null;
      if (id) void api(`/api/imports/${id}/cancel`, {}).catch(() => undefined);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(
      () => {
        const expiredId = draftId.current;
        draftId.current = null;
        if (expiredId)
          void api(`/api/imports/${expiredId}/cancel`, {}).catch(
            () => undefined,
          );
        setPreview(null);
        setSelection([]);
        setExpired(true);
        form.current?.reset();
        setError(
          'Private draft expired. Paste a fresh configuration; nothing was saved.',
        );
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        draftId.current ||
        form.current?.querySelector<HTMLTextAreaElement>('textarea')?.value
      )
        event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  function accept(value: ImportPreview) {
    draftId.current = value.id;
    setPreview(value);
    setSelection(
      value.entries.map(({ key, name, id, selected }) => ({
        key,
        name,
        id,
        selected,
      })),
    );
    setEdited(false);
    setExpired(false);
  }
  async function discard() {
    form.current?.reset();
    setBusy(true);
    setError('');
    try {
      if (draftId.current)
        await api(`/api/imports/${draftId.current}/cancel`, {});
      draftId.current = null;
      setPreview(null);
      setSelection([]);
      close();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        draftId.current = null;
        setPreview(null);
        setSelection([]);
        close();
        return;
      }
      if (mounted.current)
        setError(
          'Browser inputs cleared. Server discard could not be confirmed; retry Cancel or wait for the five-minute expiry.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        let source: string;
        try {
          source = sourceFromForm(event.currentTarget, mode);
        } catch {
          throw new Error(
            'Use a JSON argument array and an environment object. Inputs were cleared; no configuration was submitted.',
          );
        } finally {
          form.current?.reset();
        }
        const request = api<ImportPreview>('/api/imports/preview', {
          source,
          expectedRevision: revision,
        });
        source = '';
        const next = await request;
        if (!mounted.current) {
          void api(`/api/imports/${next.id}/cancel`, {}).catch(() => undefined);
          return;
        }
        accept(next);
      } else {
        const next = await api<ImportPreview>(
          `/api/imports/${preview.id}/selection`,
          { expectedRevision: preview.expectedRevision, entries: selection },
        );
        if (mounted.current) accept(next);
      }
    } catch (failure) {
      if (failure instanceof ApiError && [404, 409].includes(failure.status)) {
        draftId.current = null;
        setPreview(null);
        setSelection([]);
        void refresh();
      }
      if (mounted.current)
        setError(
          failure instanceof ApiError && failure.status === 400
            ? 'Use bounded JSON configuration with explicit executable/argument fields. Programs, mixed wrappers, duplicate keys and oversized inputs are not supported. Inputs were cleared; nothing was saved.'
            : failure instanceof ApiError && [404, 409].includes(failure.status)
              ? 'Inventory changed or the private preview expired. The draft was discarded; use a fresh preview after refreshing inventory.'
              : failure instanceof Error
                ? failure.message
                : 'Preview failed. Inputs were cleared; nothing was saved.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function exportPreview() {
    if (!preview || edited || expired) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(preview, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sanitized-import-preview.json';
    link.click();
    URL.revokeObjectURL(url);
  }
  async function prepareSave() {
    if (
      !preview ||
      edited ||
      !preview.selectionReady ||
      preview.secretReferences.length
    )
      return;
    setBusy(true);
    setError('');
    try {
      const operation = await api<OperationPreview>(
        `/api/imports/${preview.id}/save-preview`,
        { expectedRevision: preview.expectedRevision },
      );
      draftId.current = null;
      savePreview(
        operation,
        preview.entries.flatMap((entry) =>
          entry.selected && entry.definition ? [entry.definition] : [],
        ),
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Local save preview failed.',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog"
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) void discard();
      }}
    >
      <form
        ref={form}
        onSubmit={(event) => {
          void submit(event);
        }}
        autoComplete="off"
      >
        <div className="dialog-header">
          <div className="eyebrow">PREVIEW ONLY · NO EXTERNAL EFFECTS</div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close import dialog"
            disabled={busy}
            onClick={() => {
              void discard();
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="import-title">
          {preview
            ? 'Review import configuration'
            : 'Add connector — safe preview'}
        </h2>
        <p className="muted">
          Previewing never installs, executes, contacts endpoints or saves. A
          local registry save requires a separate review; execution approval is
          separate. Private import values remain memory-only; save a value-free
          definition, then add its protected credential through Authentication.
        </p>
        {!preview ? (
          <>
            <fieldset className="import-modes">
              <legend>Input format</legend>
              {(['paste', 'endpoint', 'native'] as const).map((item) => (
                <label key={item}>
                  <input
                    type="radio"
                    name="input-mode"
                    checked={mode === item}
                    onChange={() => {
                      form.current?.reset();
                      setMode(item);
                      setError('');
                    }}
                  />
                  {item === 'paste'
                    ? 'Paste JSON'
                    : item === 'endpoint'
                      ? 'HTTPS endpoint'
                      : 'Native command'}
                </label>
              ))}
            </fieldset>
            <div className="form-fields">
              {mode === 'paste' ? (
                <>
                  <label htmlFor="import-source">Configuration JSON</label>
                  <textarea
                    id="import-source"
                    name="source"
                    rows={10}
                    required
                    maxLength={48 * 1024}
                    spellCheck={false}
                    aria-describedby="import-input-help import-error"
                  />
                  <small id="import-input-help">
                    Supports mcpServers, servers, OpenCode V2 mcp.servers,
                    Docker definitions, and single entries. No scripts or JSONC.
                    Pasted values are cleared when submitted.
                  </small>
                </>
              ) : (
                <>
                  <label htmlFor="import-name">Connector name</label>
                  <input
                    id="import-name"
                    name="name"
                    maxLength={100}
                    required
                  />
                  {mode === 'endpoint' ? (
                    <>
                      <label htmlFor="import-endpoint">HTTPS endpoint</label>
                      <input
                        id="import-endpoint"
                        name="endpoint"
                        type="url"
                        required
                        maxLength={2048}
                        aria-describedby="import-input-help"
                      />
                      <label htmlFor="import-transport">Transport</label>
                      <select id="import-transport" name="transport">
                        <option value="streamable_http">Streamable HTTP</option>
                        <option value="sse">Legacy SSE</option>
                      </select>
                      <small id="import-input-help">
                        No credentials, query strings, or fragments. No endpoint
                        or DNS requests are made. Paste JSON to provide
                        write-only headers.
                      </small>
                    </>
                  ) : (
                    <>
                      <div className="discovery-actions">
                        <button
                          type="button"
                          onClick={() => {
                            const input = form.current?.elements.namedItem(
                              'executable',
                            ) as HTMLInputElement | null;
                            if (input) input.value = 'npx';
                          }}
                        >
                          Use npx
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const input = form.current?.elements.namedItem(
                              'executable',
                            ) as HTMLInputElement | null;
                            if (input) input.value = 'uvx';
                          }}
                        >
                          Use uvx
                        </button>
                      </div>
                      <label htmlFor="import-executable">Executable</label>
                      <input
                        id="import-executable"
                        name="executable"
                        required
                        maxLength={1024}
                        defaultValue="npx"
                        spellCheck={false}
                      />
                      <label htmlFor="import-args">
                        Arguments (JSON array)
                      </label>
                      <textarea
                        id="import-args"
                        name="arguments"
                        rows={3}
                        defaultValue={'["-y", "your-package@1.2.3"]'}
                        required
                        maxLength={32 * 1024}
                        spellCheck={false}
                        aria-describedby="import-input-help"
                      />
                      <label htmlFor="import-env">
                        Environment values (write-only JSON object)
                      </label>
                      <input
                        id="import-env"
                        name="environment"
                        type="password"
                        maxLength={16 * 1024}
                        spellCheck={false}
                      />
                      <small id="import-input-help">
                        Pass each argument separately. Shell syntax is not
                        expanded. All environment values become private
                        memory-only references. npx/uvx may download packages
                        only during a future approved execution.
                      </small>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="notice">
              Registry revision {preview.expectedRevision} · five-minute private
              draft · {preview.secretReferences.length} memory-only secret
              references. Source inputs have been cleared.
            </p>
            <div className="import-entries">
              {preview.entries.map((entry, index) => (
                <section
                  className="import-entry"
                  key={entry.key}
                  aria-labelledby={`entry-title-${entry.key}`}
                >
                  <h3 id={`entry-title-${entry.key}`}>
                    Entry {index + 1}: {entry.name}
                  </h3>
                  <label className="import-check">
                    <input
                      type="checkbox"
                      checked={selection[index]?.selected ?? false}
                      onChange={(event) => {
                        setSelection((entries) =>
                          entries.map((item) =>
                            item.key === entry.key
                              ? { ...item, selected: event.target.checked }
                              : item,
                          ),
                        );
                        setEdited(true);
                      }}
                    />
                    Include entry {index + 1}
                  </label>
                  <div className="import-identity">
                    <label>
                      Name
                      <input
                        aria-label={`Entry ${index + 1} name`}
                        value={selection[index]?.name ?? ''}
                        maxLength={100}
                        required
                        onChange={(event) => {
                          setSelection((entries) =>
                            entries.map((item) =>
                              item.key === entry.key
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          );
                          setEdited(true);
                        }}
                      />
                    </label>
                    <label>
                      Identifier
                      <input
                        aria-label={`Entry ${index + 1} identifier`}
                        value={selection[index]?.id ?? ''}
                        pattern="[a-z0-9][a-z0-9_-]*"
                        maxLength={80}
                        required
                        onChange={(event) => {
                          setSelection((entries) =>
                            entries.map((item) =>
                              item.key === entry.key
                                ? { ...item, id: event.target.value }
                                : item,
                            ),
                          );
                          setEdited(true);
                        }}
                      />
                    </label>
                  </div>
                  {entry.issues.length > 0 && (
                    <ul className="error-message">
                      {entry.issues.map((issue, index) => (
                        <li key={index}>
                          {issue.code.replaceAll('_', ' ')}: {issue.field}
                        </li>
                      ))}
                    </ul>
                  )}
                  {entry.conflicts.length > 0 && (
                    <p className="error-message" role="status">
                      Conflict:{' '}
                      {entry.conflicts
                        .map((conflict) => conflict.replaceAll('_', ' '))
                        .join(', ')}
                      . Rename the entry/identifier or deselect it, then update
                      the preview.
                    </p>
                  )}
                  {entry.definition && (
                    <>
                      <p>
                        {entry.definition.executionMode} ·{' '}
                        {entry.definition.transport} · execution approval: not
                        granted
                      </p>
                      <details>
                        <summary>Sanitized normalized definition</summary>
                        <pre>{JSON.stringify(entry.definition, null, 2)}</pre>
                      </details>
                    </>
                  )}
                  {entry.warnings.length > 0 && (
                    <p className="muted">
                      Review:{' '}
                      {entry.warnings
                        .map((warning) => warning.replaceAll('_', ' '))
                        .join(' · ')}
                    </p>
                  )}
                </section>
              ))}
            </div>
            <section className="review">
              <h3>Proposed scope</h3>
              <p>
                {preview.effects.proposedConnectorCount} selected definitions ·
                files: none · affected agents: none · registry/secret-store
                writes: none.
              </p>
              <p>
                Future downloads:{' '}
                {preview.effects.downloads
                  .map((download) => download.replaceAll('_', ' '))
                  .join(', ') || 'none declared'}
                . Permissions on future execution:{' '}
                {preview.effects.permissions
                  .map((permission) => permission.replaceAll('_', ' '))
                  .join(', ') || 'none declared'}
                .
              </p>
              <p role="status">
                {edited
                  ? 'Selection changed. Update preview to recheck conflicts.'
                  : preview.selectionReady
                    ? 'Selection is valid for review. Local save requires a separate preview; private import values stay memory-only.'
                    : `Review blocked: ${preview.blockers.map((blocker) => blocker.replaceAll('_', ' ')).join(', ')}.`}
              </p>
            </section>
          </>
        )}
        {error && (
          <p id="import-error" className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-footer import-footer">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void discard();
            }}
          >
            Cancel and discard
          </button>
          {preview && (
            <button
              type="button"
              disabled={
                busy ||
                edited ||
                expired ||
                !preview.selectionReady ||
                preview.secretReferences.length > 0
              }
              onClick={() => {
                void prepareSave();
              }}
              title={
                preview.secretReferences.length
                  ? 'Private import values stay memory-only; enter protected credentials separately through Authentication.'
                  : 'Review a separate local-only registry save.'
              }
            >
              Preview local save
            </button>
          )}
          {preview && (
            <button
              type="button"
              disabled={busy || edited || expired}
              onClick={exportPreview}
            >
              Export sanitized preview
            </button>
          )}
          <button
            className="primary"
            type="submit"
            disabled={busy || (expired && !!preview)}
          >
            {busy
              ? 'Checking…'
              : preview
                ? 'Update preview'
                : 'Preview configuration'}
          </button>
          {preview && (
            <button
              type="button"
              disabled
              title="Direct private-draft apply is unsupported; use a separate value-free save and Authentication."
            >
              Apply import (unavailable)
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
