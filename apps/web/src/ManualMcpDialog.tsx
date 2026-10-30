import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ManualMcpSchema,
  PackageSpecSchema,
  type RegistryOption,
  EndpointSchema,
  isLocalHttpEndpoint,
  type SmartPasteResult,
} from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';
import { SmartPaste } from './SmartPaste.js';
import { BundleInstaller } from './BundleInstaller.js';

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
  suggestion,
  importJson,
  initialType = 'stdio',
}: {
  revision: number;
  close: () => void;
  refresh: () => Promise<void>;
  suggestion?: RegistryOption | undefined;
  importJson?: (source: string) => Promise<void>;
  initialType?: 'stdio' | 'npx';
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    form = useRef<HTMLFormElement>(null),
    env = useRef<HTMLTextAreaElement>(null),
    headers = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<Record<string, string> | null>(null);
  const [prefillRevision, setPrefillRevision] = useState(0),
    [localEndpoint, setLocalEndpoint] = useState(false),
    [localOptIn, setLocalOptIn] = useState(false);
  const [type, setType] = useState<
      'stdio' | 'docker' | 'streamable_http' | 'sse' | 'npx' | 'uvx'
    >(suggestion?.prefill.type ?? initialType),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [validation, setValidation] = useState('');
  const clear = () => {
    if (env.current) env.current.value = '';
    if (headers.current) headers.current.value = '';
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      clear();
      if (pending.current)
        for (const key of Object.keys(pending.current))
          pending.current[key] = '';
      pending.current = null;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const values = pending.current;
    if (!values || !form.current) return;
    pending.current = null;
    for (const [name, value] of Object.entries(values)) {
      const field = form.current.elements.namedItem(name);
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement
      )
        field.value = value;
    }
    if (env.current) env.current.value = values.privateEnv ?? '';
    if (headers.current) headers.current.value = '';
    for (const key of Object.keys(values)) values[key] = '';
    validate();
  }, [prefillRevision]);
  async function smartReview(value: SmartPasteResult) {
    clear();
    setError('');
    setLocalOptIn(false);
    const approval = form.current?.elements.namedItem('approveExecution');
    if (approval instanceof HTMLInputElement) approval.checked = false;
    if (value.kind === 'json') {
      if (!importJson) throw new Error('Use Add connector for JSON imports.');
      setBusy(true);
      try {
        await importJson(value.source);
      } finally {
        setBusy(false);
      }
      return;
    }
    const data = value.prefill;
    pending.current = {
      name: data.name,
      url: data.url ?? '',
      packageName: data.packageName ?? '',
      packageVersion: data.packageVersion ?? '',
      entryPoint: data.entryPoint ?? '',
      image: data.image ?? '',
      args: JSON.stringify(data.args),
      ports: JSON.stringify(data.ports),
      privateEnv: Object.keys(data.env).length ? JSON.stringify(data.env) : '',
    };
    setType(data.type);
    setLocalEndpoint(!!data.url && isLocalHttpEndpoint(data.url));
    setPrefillRevision((revision) => revision + 1);
  }
  function validate() {
    try {
      const fields = new FormData(form.current!);
      const selected = String(fields.get('type') || type);
      if (selected === 'npx' || selected === 'uvx')
        PackageSpecSchema.parse({
          manager: selected === 'npx' ? 'npm' : 'uvx',
          name: String(fields.get('packageName') || ''),
          version: String(fields.get('packageVersion') || ''),
          entryPoint:
            String(fields.get('entryPoint') || '') ||
            String(fields.get('packageName') || '')
              .split('/')
              .at(-1),
        });
      ManualMcpSchema.shape.args.parse(
        JSON.parse(String(fields.get('args') || '[]')),
      );
      ManualMcpSchema.shape.ports.parse(
        JSON.parse(String(fields.get('ports') || '[]')),
      );
      ManualMcpSchema.shape.env.parse(map(env.current?.value ?? ''));
      ManualMcpSchema.shape.headers.parse(map(headers.current?.value ?? ''));
      const url = String(fields.get('url') || '');
      if (selected === 'sse' || selected === 'streamable_http') {
        EndpointSchema.parse(url);
        if (isLocalHttpEndpoint(url) && fields.get('localHttpOptIn') !== 'on')
          throw new Error();
      }
      setValidation('');
    } catch {
      setValidation(
        'Use exact package versions, JSON args/ports and protected credential objects. Remote endpoints require HTTPS, or explicit-port loopback HTTP with the local opt-in checked.',
      );
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    let input: ReturnType<typeof ManualMcpSchema.parse> | undefined;
    try {
      const fields = new FormData(form.current!);
      input = ManualMcpSchema.parse({
        expectedRevision: revision,
        type,
        packageName: String(fields.get('packageName') || ''),
        packageVersion: String(fields.get('packageVersion') || ''),
        entryPoint: String(fields.get('entryPoint') || ''),
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
        localHttpOptIn: fields.get('localHttpOptIn') === 'on',
      });
      if (suggestion && type === suggestion.prefill.type)
        for (const required of suggestion.requirements.filter(
          (item) => item.required,
        )) {
          if (
            !(required.location === 'environment' ? input.env : input.headers)[
              required.name
            ]
          )
            throw new Error('Required registry credential missing.');
        }
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
        'Save failed or input is invalid. Use an absolute .exe, HTTPS or opted-in loopback endpoint, or an exactly pinned package. No secret value is retained in this form.',
      );
    } finally {
      if (input) {
        for (const values of [input.env, input.headers])
          for (const key of Object.keys(values)) values[key] = '';
      }
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog manual-dialog"
      aria-labelledby="manual-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
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
        onChange={(event) => {
          const name =
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLSelectElement ||
            event.target instanceof HTMLTextAreaElement
              ? event.target.name
              : '';
          if (name !== 'approveExecution' && name !== 'autoSync') {
            const approval = form.current?.elements.namedItem(
              'approveExecution',
            ) as HTMLInputElement | null;
            if (approval) approval.checked = false;
          }
          if (name === 'url' || name === 'type') {
            setLocalOptIn(false);
            const optIn = form.current?.elements.namedItem('localHttpOptIn');
            if (optIn instanceof HTMLInputElement) optIn.checked = false;
            const url = form.current?.elements.namedItem('url');
            setLocalEndpoint(
              url instanceof HTMLInputElement && isLocalHttpEndpoint(url.value),
            );
          }
          validate();
        }}
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
            disabled={busy}
            onClick={() => {
              clear();
              close();
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="manual-title">Add Manual MCP</h2>
        {!notice && !suggestion && (
          <>
            <SmartPaste disabled={busy} onReview={smartReview} />
            <BundleInstaller
              revision={revision}
              refresh={refresh}
              onBusy={setBusy}
              disabled={busy}
            />
          </>
        )}
        {suggestion && (
          <section className="review">
            <h3>Registry suggestion — review before saving</h3>
            <p>{suggestion.warnings.join(' ')}</p>
            {suggestion.requirements.map((item) => (
              <p key={`${item.location}:${item.name}`}>
                <strong>{item.name}</strong> · {item.location} ·{' '}
                {item.required ? 'required' : 'optional'} ·{' '}
                {item.secret ? 'secret' : 'configuration'} {item.description}
              </p>
            ))}
            <p>
              No publisher credential values or defaults have been imported.
            </p>
          </section>
        )}
        <p>
          Save a definition without running it. Credentials go through the
          protected write-only store, never into agent settings. Auto-sync does
          not bypass authentication or agent approval.
        </p>
        {notice ? (
          <p role="status" className="notice">
            {notice}
          </p>
        ) : (
          <>
            <div className="form-fields">
              <label htmlFor="manual-name">MCP name</label>
              <input
                id="manual-name"
                name="name"
                required
                maxLength={100}
                defaultValue={suggestion?.prefill.name}
              />
              <label htmlFor="manual-type">Connection type</label>
              <select
                id="manual-type"
                name="type"
                value={type}
                onChange={(event) => {
                  clear();
                  setType(event.target.value as typeof type);
                  setValidation('');
                }}
              >
                <option value="stdio">Stdio — local executable</option>
                <option value="docker">Docker image</option>
                <option value="npx">npm / npx — pinned package</option>
                <option value="uvx">Python / uvx — pinned package</option>
                <option value="streamable_http">Remote HTTP</option>
                <option value="sse">Remote SSE</option>
              </select>
              {(type === 'npx' || type === 'uvx') && (
                <>
                  <label htmlFor="manual-package">Package name</label>
                  <input
                    id="manual-package"
                    name="packageName"
                    defaultValue={suggestion?.prefill.packageName}
                    required
                    spellCheck={false}
                    placeholder={
                      type === 'npx' ? '@scope/mcp-server' : 'mcp-server-time'
                    }
                  />
                  <label htmlFor="manual-version">Exact package version</label>
                  <input
                    id="manual-version"
                    name="packageVersion"
                    defaultValue={suggestion?.prefill.packageVersion}
                    required
                    spellCheck={false}
                    placeholder="1.2.3"
                    aria-describedby="manual-package-help"
                  />
                  <label htmlFor="manual-entry">
                    Package executable name (optional)
                  </label>
                  <input
                    id="manual-entry"
                    name="entryPoint"
                    defaultValue={suggestion?.prefill.entryPoint}
                    spellCheck={false}
                    placeholder="Defaults to the unscoped package name"
                  />
                  <small id="manual-package-help">
                    No latest, version ranges, URLs or local paths. After
                    approval, Prepare &amp; test package installs privately
                    under Hub data. npm install scripts and Python source builds
                    are disabled. No global npm/system Python changes.
                  </small>
                </>
              )}
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
              {type === 'stdio' ||
              type === 'docker' ||
              type === 'npx' ||
              type === 'uvx' ? (
                <>
                  <label htmlFor="manual-args">
                    Arguments (JSON array, no shell expansion)
                  </label>
                  <textarea
                    id="manual-args"
                    name="args"
                    defaultValue={JSON.stringify(
                      suggestion?.prefill.args ?? [],
                    )}
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
                  <label htmlFor="manual-url">MCP endpoint URL</label>
                  <input
                    id="manual-url"
                    name="url"
                    defaultValue={suggestion?.prefill.url}
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
                  {localEndpoint && (
                    <label className="import-check">
                      <input
                        name="localHttpOptIn"
                        type="checkbox"
                        checked={localOptIn}
                        onChange={(event) =>
                          setLocalOptIn(event.target.checked)
                        }
                      />
                      I opt in to unencrypted local HTTP for this exact loopback
                      endpoint and port.
                    </label>
                  )}
                </>
              )}
              <small id="manual-private">
                Exact credential values are hidden after submission and cleared
                on error/close. For Authorization, include the documented prefix
                in the exact value. Never put secrets in args, names or URLs.
              </small>
              <label className="import-check">
                <input
                  name="autoSync"
                  type="checkbox"
                  defaultChecked={!suggestion}
                />
                Auto-sync currently integrated agents
              </label>
              <label className="import-check">
                <input name="approveExecution" type="checkbox" />I trust this
                exact executable/image/endpoint/package version and approve its
                execution/file/network/download permissions.
              </label>
              <p className="notice">
                Saving does not install or execute anything. Approved package
                preparation can download dependencies and a private Python
                runtime. Job Objects contain process lifetimes, not file/network
                permissions.
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
            disabled={busy}
            onClick={() => {
              clear();
              close();
            }}
          >
            {notice ? 'Close' : 'Cancel'}
          </button>
          {!notice && (
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
