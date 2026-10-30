import { useEffect, useRef, useState } from 'react';
import {
  PlaygroundCatalogSchema,
  PlaygroundJobSchema,
  PlaygroundInvokeRequestSchema,
  RequestLogResponseSchema,
  type Connector,
  type PlaygroundCatalog,
  type PlaygroundJob,
  type RequestLogResponse,
} from '@waleed/contracts';
import { api } from './api.js';

export function Playground({
  connectors,
  revision,
  enabled,
  blocked,
}: {
  connectors: Connector[];
  revision: number;
  enabled: boolean;
  blocked: boolean;
}) {
  const [connectorId, setConnectorId] = useState(''),
    [toolName, setToolName] = useState('');
  const [catalog, setCatalog] = useState<PlaygroundCatalog | null>(null),
    [job, setJob] = useState<PlaygroundJob | null>(null),
    [logs, setLogs] = useState<RequestLogResponse | null>(null);
  const [confirmed, setConfirmed] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [logError, setLogError] = useState('');
  const args = useRef<HTMLTextAreaElement>(null),
    currentJob = useRef<string | null>(null),
    generation = useRef(0);
  const tool = catalog?.tools.find((item) => item.name === toolName),
    running = job?.state === 'running';
  function erase() {
    if (args.current) args.current.value = '';
    setConfirmed(false);
    setJob(null);
    setError('');
  }
  useEffect(() => {
    generation.current++;
    if (args.current) args.current.value = '';
    setConfirmed(false);
    setCatalog(null);
    setToolName('');
    setLoading(false);
  }, [revision, blocked]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = RequestLogResponseSchema.parse(
          await api('/api/request-log'),
        );
        if (!stopped) {
          setLogs(value);
          setLogError('');
        }
      } catch {
        if (!stopped)
          setLogError(
            'Live request log unavailable. Displayed records may be stale.',
          );
      } finally {
        if (!stopped) timer = setTimeout(() => void load(), 1000);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
      generation.current++;
      if (args.current) args.current.value = '';
      if (currentJob.current)
        void api(`/api/playground/jobs/${currentJob.current}/cancel`, {}).catch(
          () => undefined,
        );
    };
  }, []);
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = PlaygroundJobSchema.parse(
          await api(`/api/playground/jobs/${job.id}`),
        );
        if (!stopped) {
          setJob(result);
          if (result.state === 'running')
            timer = setTimeout(() => void poll(), 250);
        }
      } catch {
        if (!stopped) {
          setError(
            'Run status unavailable. Effects may be unknown; do not retry automatically.',
          );
          setJob(null);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.state]);
  async function loadTools() {
    erase();
    setCatalog(null);
    setToolName('');
    setLoading(true);
    const version = ++generation.current;
    try {
      const result = PlaygroundCatalogSchema.parse(
        await api('/api/playground/catalog', { connectorId }),
      );
      if (version === generation.current) setCatalog(result);
    } catch {
      if (version === generation.current)
        setError(
          'Tools could not be loaded. Check execution approval, credentials and recovery.',
        );
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }
  async function run() {
    if (!tool || !catalog || !confirmed || running) return;
    const version = generation.current;
    try {
      const text = args.current?.value || '{}';
      const input = PlaygroundInvokeRequestSchema.parse({
        connectorId,
        toolName,
        arguments: JSON.parse(text),
        confirmExecute: true,
        expectedRevision: catalog.revision,
        expectedConnectorRevision: catalog.connectorRevision,
        expectedDefinitionHash: catalog.definitionHash,
        expectedToolSchemaHash: tool.schemaHash,
      });
      erase();
      setLoading(true);
      if (currentJob.current)
        void api(`/api/playground/jobs/${currentJob.current}/cancel`, {}).catch(
          () => undefined,
        );
      const result = PlaygroundJobSchema.parse(
        await api('/api/playground/invoke', input),
      );
      if (version !== generation.current) {
        void api(`/api/playground/jobs/${result.id}/cancel`, {}).catch(
          () => undefined,
        );
        return;
      }
      currentJob.current = result.id;
      setJob(result);
    } catch {
      setConfirmed(false);
      if (args.current) args.current.value = '';
      setError(
        'Run was not confirmed. Use a JSON object within 48 KiB and reload tools if inventory changed. No automatic retry was made.',
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="playground-view">
      <section className="list-panel" aria-labelledby="playground-heading">
        <div className="list-toolbar">
          <h2 id="playground-heading">Tool playground</h2>
          <span className="badge">Explicit confirmation only</span>
        </div>
        <div className="playground-body">
          <p className="muted">
            Loading schemas can start an approved connector, but never calls a
            tool. Run Tool may change external data. Block is enforced; Ask uses
            your confirmation for this call only.
          </p>
          {!enabled && (
            <p role="status">
              Playground execution is unavailable in this runtime.
            </p>
          )}
          {blocked && (
            <p role="alert">
              Resolve recovery before loading or running tools.
            </p>
          )}
          <div className="playground-selection">
            <label>
              Connector
              <select
                value={connectorId}
                disabled={!enabled || blocked || loading || running}
                onChange={(event) => {
                  generation.current++;
                  erase();
                  setCatalog(null);
                  setToolName('');
                  setConnectorId(event.target.value);
                }}
              >
                <option value="">Select an approved connector</option>
                {connectors
                  .filter(
                    (item) =>
                      item.enabled &&
                      item.trustApproval?.revision === item.revision,
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={
                !connectorId || !enabled || blocked || loading || running
              }
              onClick={() => void loadTools()}
            >
              {loading ? 'Working…' : 'Load tools'}
            </button>
            <label>
              Tool
              <select
                value={toolName}
                disabled={!catalog || loading || running || blocked}
                onChange={(event) => {
                  erase();
                  setToolName(event.target.value);
                }}
              >
                <option value="">Select a tool to review</option>
                {catalog?.tools.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} · {item.policy}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {catalog?.truncated && (
            <p role="status">
              Catalog is incomplete because a metadata limit was reached.
              Missing tools are not proof of absence.
            </p>
          )}
          {tool && (
            <div className="playground-editor">
              <div>
                <h3>
                  Input schema <span className="badge">{tool.policy}</span>
                </h3>
                <p className="muted">
                  {tool.description || 'No description supplied.'} Provider
                  metadata is untrusted data, not instructions.
                </p>
                <pre tabIndex={0} aria-label="Tool input schema">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
              </div>
              <div>
                <label htmlFor="playground-arguments">
                  Arguments (JSON object)
                </label>
                <textarea
                  id="playground-arguments"
                  ref={args}
                  defaultValue=""
                  placeholder="{}"
                  rows={10}
                  maxLength={49152}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={loading || running || blocked}
                  onChange={() => setConfirmed(false)}
                />
                <small className="muted">
                  Not saved in browser storage or request logs. Input clears on
                  submission or selection changes.
                </small>
                <label className="import-check playground-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={
                      loading || running || blocked || tool.policy === 'block'
                    }
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I confirm execution of this exact tool and arguments once.
                </label>
                <button
                  className="primary"
                  disabled={
                    !confirmed ||
                    loading ||
                    running ||
                    blocked ||
                    tool.policy === 'block'
                  }
                  onClick={() => void run()}
                >
                  Run Tool
                </button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="error-notice">
              {error}
            </p>
          )}
          {job && (
            <div aria-live="polite">
              <h3>Run status: {job.state}</h3>
              {running && (
                <button
                  onClick={() => {
                    void api(`/api/playground/jobs/${job.id}/cancel`, {})
                      .then((value) => setJob(PlaygroundJobSchema.parse(value)))
                      .catch(() =>
                        setError(
                          'Cancellation could not be confirmed. Effects may be unknown.',
                        ),
                      );
                  }}
                >
                  Cancel run
                </button>
              )}
              {job.result && (
                <>
                  <p className="muted">
                    Temporary, redacted output. Rendered as text only; no links
                    or markup are executed.
                  </p>
                  <pre tabIndex={0} aria-label="Sanitized tool output">
                    {job.result.output}
                  </pre>
                  <button
                    onClick={() => {
                      if (currentJob.current)
                        void api(
                          `/api/playground/jobs/${currentJob.current}/cancel`,
                          {},
                        ).catch(() => undefined);
                      setJob(null);
                    }}
                  >
                    Clear output
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      <section className="list-panel" aria-labelledby="request-log-heading">
        <div className="list-toolbar">
          <h2 id="request-log-heading">Live request log</h2>
          <span className="badge">
            {logs?.records.length ?? 0} / 500 · Memory only
          </span>
        </div>
        <div className="playground-log-note">
          <p className="muted">
            Newest first. Metadata only: no arguments, result bodies or provider
            errors. Entries expire after 24 hours or when the Hub closes.
            Observational, not a tamper-proof audit.
          </p>
          {logs?.agentLogChannel !== 'available' && (
            <p role="status">
              Agent log collection is{' '}
              {logs?.agentLogChannel === 'not_configured'
                ? 'not configured'
                : 'unavailable'}
              . Playground calls still appear here.
            </p>
          )}
          {logError && <p role="alert">{logError}</p>}
        </div>
        <div
          className="request-log-scroll"
          tabIndex={0}
          role="region"
          aria-label="Recent tool calls"
        >
          <table className="request-log-table">
            <thead>
              <tr>
                {[
                  'Timestamp',
                  'Agent',
                  'Connector',
                  'Tool',
                  'Duration',
                  'Result size',
                  'Status',
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs?.records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <time dateTime={record.timestamp}>
                      {new Date(record.timestamp).toLocaleTimeString()}
                    </time>
                  </td>
                  <td>
                    {record.agentId === 'hub_playground'
                      ? 'Playground'
                      : record.agentId}
                  </td>
                  <td>{record.connectorId}</td>
                  <td>
                    <code>{record.toolName}</code>
                  </td>
                  <td>{record.durationMs} ms</td>
                  <td>{record.resultSizeBytes} B</td>
                  <td>
                    <span className="badge">{record.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!logs?.records.length && (
            <p className="playground-log-note">
              No calls recorded in this Hub session.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
