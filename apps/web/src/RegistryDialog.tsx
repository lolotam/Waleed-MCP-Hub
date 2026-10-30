import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RegistryServer, RegistryOption } from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';

export function RegistryDialog({
  close,
  select,
}: {
  close: () => void;
  select: (option: RegistryOption) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState(''),
    [servers, setServers] = useState<RegistryServer[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [searched, setSearched] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  async function search(event?: FormEvent, next?: string) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({
        search: query,
        limit: '20',
        ...(next ? { cursor: next } : {}),
      });
      const result = await api<{
        servers: RegistryServer[];
        nextCursor: string | null;
      }>(`/api/registry/servers?${params}`);
      setServers(result.servers);
      setCursor(result.nextCursor);
      setSearched(true);
    } catch {
      setError(
        'Official registry is unavailable. No connector was added. Retry or add a manual MCP.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog auth-dialog"
      aria-labelledby="registry-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="dialog-header">
        <span className="eyebrow">OFFICIAL MCP REGISTRY · METADATA ONLY</span>
        <button
          className="icon-button"
          aria-label="Close registry browser"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="registry-title">Find an MCP server</h2>
      <p className="muted">
        Search registry.modelcontextprotocol.io. Publisher listings are not
        execution approvals. Choose a connection to pre-fill the Add MCP form;
        review its version, permissions and credentials before saving.
      </p>
      <form className="form-fields" onSubmit={(event) => void search(event)}>
        <label htmlFor="registry-search">Search official registry</label>
        <input
          id="registry-search"
          type="search"
          maxLength={100}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(null);
          }}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search registry'}
        </button>
      </form>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {searched && !servers.length && (
        <p role="status">No active supported listings on this page.</p>
      )}
      {servers.map((server) => (
        <section className="review" key={`${server.name}:${server.version}`}>
          <h3>{server.title}</h3>
          <p>
            <code>{server.name}</code> · {server.version}
          </p>
          <p>{server.description}</p>
          {server.options.map((option) => (
            <div key={option.id}>
              <p>
                {option.prefill.type} ·{' '}
                {option.prefill.url ??
                  `${option.prefill.packageName}@${option.prefill.packageVersion}`}
              </p>
              {!!option.requirements.length && (
                <p>
                  Required setup:{' '}
                  {option.requirements
                    .map(
                      (item) =>
                        `${item.name}${item.required ? ' (required)' : ''}`,
                    )
                    .join(', ')}
                </p>
              )}
              <button disabled={busy} onClick={() => select(option)}>
                Review {option.prefill.type} connection
              </button>
            </div>
          ))}
          {!!server.unsupportedOptions && (
            <p className="muted">
              {server.unsupportedOptions} connection options need manual setup
              (unsupported runtime, unpinned version or template).
            </p>
          )}
        </section>
      ))}
      <footer className="dialog-footer">
        <button disabled={busy} onClick={close}>
          Close
        </button>
        {cursor && (
          <button
            disabled={busy}
            onClick={() => void search(undefined, cursor)}
          >
            Next registry page
          </button>
        )}
      </footer>
    </dialog>
  );
}
