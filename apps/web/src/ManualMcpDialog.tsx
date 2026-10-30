import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ManualMcpSchema } from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';
import { PackageInstall } from './PackageInstall.js';

const map = (text: string): Record<string, string> => {
  const value: unknown = JSON.parse(text || '{}');
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  )
    throw new Error();
  return value as Record<string, string>;
};
export function ManualMcpDialog({
  revision,
  close,
  refresh,
}: {
  revision: number;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    form = useRef<HTMLFormElement>(null),
    env = useRef<HTMLTextAreaElement>(null),
    headers = useRef<HTMLTextAreaElement>(null);
  const [type, setType] = useState<
      'stdio' | 'docker' | 'streamable_http' | 'sse' | 'npm'
    >('stdio'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [validation, setValidation] = useState(''),
    [packageRunning, setPackageRunning] = useState(false);
  const clear = () => {
    if (env.current) env.current.value = '';
    if (headers.current) headers.current.value = '';
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      clear();
      previous?.focus();
    };
  }, []);
  function validate() {
    // The managed package flow has its own fields and its own validation.
    if (type === 'npm') {
      setValidation('');
      return;
    }
    try {
      const fields = new FormData(form.current!);
      ManualMcpSchema.shape.args.parse(
        JSON.parse(String(fields.get('args') || '[]')),
      );
      ManualMcpSchema.shape.ports.parse(
        JSON.parse(String(fields.get('ports') || '[]')),
      );
      ManualMcpSchema.shape.env.parse(map(env.current?.value ?? ''));
      ManualMcpSchema.shape.headers.parse(map(headers.current?.value ?? ''));
      const url = String(fields.get('url') || '');
      if (type === 'sse' || type === 'streamable_http') {
        const endpoint = new URL(url);
        if (
          endpoint.protocol !== 'https:' ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash
        )
          throw new Error();
      }
      setValidation('');
    } catch {
      setValidation(
        'Use JSON arrays for args/ports, string-valued JSON objects for credentials, and an HTTPS URL without credentials or query parameters.',
      );
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    // The npm package flow has its own buttons and its own request.
    if (type === 'npm') return;
    setBusy(true);
    setError('');
    let input: ReturnType<typeof ManualMcpSchema.parse> | undefined;
    try {
      const fields = new FormData(form.current!);
      input = ManualMcpSchema.parse({
        expectedRevision: revision,
        type,
        name: String(fields.get('name')),
        command: String(fields.get('command') || ''),
        image: String(fields.get('image') || ''),
        url: String(fields.get('url') || ''),
        args: JSON.parse(String(fields.get('args') || '[]')),
        ports: JSON.parse(String(fields.get('ports') || '[]')),
        env: map(env.current?.value ?? ''),
        headers: map(headers.current?.value ?? ''),
        autoSync: fields.get('autoSync') === 'on',
        approveExecution: fields.get('approveExecution') === 'on',
        confirmSave: true,
      });
      clear();
      const result = await api<{
        connectorId: string;
        state: string;
        requiresApproval: boolean;
        message?: string;
        sync: { agents: Array<{ status: string }> } | null;
      }>('/api/connectors/manual', input);
      setNotice(
        result.state === 'partially_saved'
          ? `${result.message!} Saved connector: ${result.connectorId}.`
          : `MCP definition saved. ${result.requiresApproval ? 'Execution approval is still required. ' : ''}Authentication is not verified. ${result.sync ? `${result.sync.agents.length} integrated agent configurations checked; ${result.sync.agents.filter((agent) => agent.status === 'conflict').length} conflicts. Reconnect/trust may be needed.` : 'Auto-sync was not requested.'}`,
      );
      await refresh();
    } catch {
      clear();
      setError(
        'Save failed or input is invalid. Use an approved absolute .exe/HTTPS endpoint and valid JSON. No secret value is retained in this form.',
      );
    } finally {
      if (input) {
        for (const values of [input.env, input.headers])
          for (const key of Object.keys(values)) values[key] = '';
      }
      setBusy(false);
    }
  }
  // The connection type stays available in every mode, so the user can leave
  // the managed package flow again.
  const typeSelect = (
    <>
      <label htmlFor="manual-type">Connection type</label>
      <select
        id="manual-type"
        value={type}
        onChange={(event) => {
          clear();
          setType(event.target.value as typeof type);
          setValidation('');
        }}
      >
        <option value="stdio">Stdio — local executable</option>
        <option value="docker">Docker image</option>
        <option value="streamable_http">Remote HTTP</option>
        <option value="sse">Remote SSE</option>
        <option value="npm">npm package — managed install</option>
      </select>
    </>
  );
  return (
    <dialog
      ref={dialog}
      className="import-dialog manual-dialog"
      aria-labelledby="manual-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !packageRunning) {
          clear();
          close();
        }
      }}
    >
      <form
        ref={form}
        onSubmit={(event) => {
          void save(event);
        }}
        onChange={validate}
        autoComplete="off"
      >
        <div className="dialog-header">
          <div className="eyebrow">
            REGISTRY → PROTECTED CREDENTIALS → AGENTS
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close manual MCP dialog"
            disabled={busy || packageRunning}
            onClick={() => {
              clear();
              close();
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="manual-title">Add Manual MCP</h2>
        <p>
          Save a definition without running it. Credentials go through the
          protected write-only store, never into agent settings. Auto-sync does
          not bypass authentication or agent approval.
        </p>
        {notice ? (
          <p role="status" className="notice">
            {notice}
          </p>
        ) : type === 'npm' ? (
          <>
            <div className="form-fields">{typeSelect}</div>
            <PackageInstall
              seed={{ mode: 'install' }}
              close={close}
              refresh={refresh}
              onRunning={setPackageRunning}
              showCancel={false}
            />
          </>
        ) : (
          <>
            <div className="form-fields">
              <label htmlFor="manual-name">MCP name</label>
              <input id="manual-name" name="name" required maxLength={100} />
              {typeSelect}
              {type === 'stdio' && (
                <>
                  <label htmlFor="manual-command">
                    Absolute command (.exe)
                  </label>
                  <input
                    id="manual-command"
                    name="command"
                    required
                    spellCheck={false}
                    placeholder="C:\Tools\server.exe"
                  />
                </>
              )}
              {type === 'docker' && (
                <>
                  <label htmlFor="manual-image">Docker image</label>
                  <input
                    id="manual-image"
                    name="image"
                    required
                    spellCheck={false}
                  />
                  <label htmlFor="manual-ports">Loopback ports (JSON)</label>
                  <input
                    id="manual-ports"
                    name="ports"
                    defaultValue="[]"
                    spellCheck={false}
                  />
                  <small>
                    Example: [{`{"host":8080,"container":8080}`}]. Published on
                    127.0.0.1 only.
                  </small>
                </>
              )}
              {type === 'stdio' || type === 'docker' ? (
                <>
                  <label htmlFor="manual-args">
                    Arguments (JSON array, no shell expansion)
                  </label>
                  <textarea
                    id="manual-args"
                    name="args"
                    defaultValue="[]"
                    spellCheck={false}
                  />
                  <label htmlFor="manual-env">
                    Protected environment values (write-only JSON)
                  </label>
                  <textarea
                    ref={env}
                    id="manual-env"
                    spellCheck={false}
                    aria-describedby="manual-private"
                  />
                </>
              ) : (
                <>
                  <label htmlFor="manual-url">HTTPS MCP URL</label>
                  <input
                    id="manual-url"
                    name="url"
                    type="url"
                    required
                    spellCheck={false}
                  />
                  <label htmlFor="manual-headers">
                    Protected headers (write-only JSON)
                  </label>
                  <textarea
                    ref={headers}
                    id="manual-headers"
                    spellCheck={false}
                    aria-describedby="manual-private"
                  />
                </>
              )}
              <small id="manual-private">
                Exact credential values are hidden after submission and cleared
                on error/close. For Authorization, include the documented prefix
                in the exact value. Never put secrets in args, names or URLs.
              </small>
              <label className="import-check">
                <input name="autoSync" type="checkbox" defaultChecked />
                Auto-sync currently integrated agents
              </label>
              <label className="import-check">
                <input name="approveExecution" type="checkbox" />I trust this
                exact executable/image/endpoint and approve its
                execution/file/network/download permissions.
              </label>
              <p className="notice">
                Agent configuration is not live verification. Docker
                keychain-backed execution remains unavailable until a verified
                gateway recipe exists.
              </p>
            </div>
            {validation && (
              <p role="alert" className="error-message">
                {validation}
              </p>
            )}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </>
        )}
        <footer className="dialog-footer">
          <button
            type="button"
            disabled={busy || packageRunning}
            onClick={() => {
              clear();
              close();
            }}
          >
            {notice ? 'Close' : 'Cancel'}
          </button>
          {!notice && type !== 'npm' && (
            <button
              className="primary"
              disabled={busy || !!validation}
              type="submit"
            >
              {busy ? 'Saving…' : 'Save MCP'}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
