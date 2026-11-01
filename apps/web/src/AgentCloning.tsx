import { useEffect, useRef, useState } from 'react';
import { CloneJobSchema, type CloneJob } from '@waleed/contracts';
import { api } from './api.js';

const preference = 'wmh-agent-import-reviewed-v1';
const running = (job: CloneJob | null) =>
  !!job && ['queued', 'running'].includes(job.state);
export function AgentCloning({
  disabled,
  refresh,
  openManual,
}: {
  disabled: boolean;
  refresh: () => Promise<unknown>;
  openManual: () => void;
}) {
  const [job, setJob] = useState<CloneJob | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<{ [key: string]: string }>({}),
    [bins, setBins] = useState<{ [key: string]: string }>({});
  const [reviewed, setReviewed] = useState(false),
    [expanded, setExpanded] = useState(true);
  const mounted = useRef(true),
    started = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aborts = useRef(new Set<AbortController>());
  const candidates = job?.candidates ?? [];
  const saved = new Set(
    job?.results.filter((item) => item.connectorId).map((item) => item.key),
  );
  const choices = candidates.filter(
    (item) => selected.has(item.key) && !saved.has(item.key),
  );
  const needsPackages = choices.some(
    (item) => item.packageProposal && !item.packagePreview,
  );
  const distinct = new Set(
    choices.map((item) => names[item.key]?.trim().toLowerCase()),
  );
  async function follow(initial: CloneJob) {
    if (!mounted.current) return;
    setJob(initial);
    if (running(initial)) {
      timer.current = setTimeout(() => {
        const controller = new AbortController();
        aborts.current.add(controller);
        void api(
          `/api/agent-cloning/${initial.id}`,
          undefined,
          controller.signal,
        )
          .then((value) => follow(CloneJobSchema.parse(value)))
          .catch(() => {
            if (mounted.current) {
              setError(
                'Scan status could not be read. Scan again before copying.',
              );
              setBusy(false);
            }
          })
          .finally(() => aborts.current.delete(controller));
      }, 500);
    } else {
      setBusy(false);
      if (initial.reason)
        setError(
          `Import ${initial.reason.replaceAll('_', ' ')}. Rescan or inspect saved connectors before retrying.`,
        );
      if (initial.results.length) {
        setSelected(
          (current) =>
            new Set(
              [...current].filter(
                (key) =>
                  !initial.results.some(
                    (item) => item.key === key && item.connectorId,
                  ),
              ),
            ),
        );
        setReviewed(false);
        await refresh();
      }
    }
  }
  async function action(path: string, body: unknown) {
    setBusy(true);
    setReviewed(false);
    setError('');
    try {
      await follow(CloneJobSchema.parse(await api(path, body)));
    } catch {
      if (mounted.current) {
        setError(
          'The request was not confirmed. Refresh the scan and inspect Connectors before retrying a copy.',
        );
        setBusy(false);
      }
    }
  }
  async function scan() {
    setSelected(new Set());
    setReviewed(false);
    setNames({});
    setBins({});
    setExpanded(true);
    await action('/api/agent-cloning/scan', {});
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      for (const controller of aborts.current) controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!started.current && !disabled) {
      started.current = true;
      let done = false;
      try {
        done = localStorage.getItem(preference) === 'done';
      } catch {
        /* Preferences are optional. */
      }
      if (done) setExpanded(false);
      else void scan();
    }
    // Initial authenticated opening only. Explicit Scan again refreshes sources.
  }, [disabled]);
  useEffect(() => {
    if (!job) return;
    setNames((current) =>
      Object.fromEntries(
        job.candidates.map((item) => [
          item.key,
          current[item.key] ??
            (item.existing
              ? `${item.name.slice(0, 70)} (${item.agentId})`
              : item.name),
        ]),
      ),
    );
    setBins((current) =>
      Object.fromEntries(
        job.candidates.map((item) => [
          item.key,
          current[item.key] ??
            (item.packagePreview?.entries.length === 1
              ? item.packagePreview.entries[0]!.entry
              : ''),
        ]),
      ),
    );
  }, [job]);
  function toggle(keys: string[], checked: boolean) {
    setReviewed(false);
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys)
        if (checked) next.add(key);
        else next.delete(key);
      return next;
    });
  }
  function dismiss() {
    try {
      localStorage.setItem(preference, 'done');
    } catch {
      /* Preferences are optional. */
    }
    setExpanded(false);
  }
  const available = candidates.filter(
    (item) => item.state !== 'needs_setup' && !saved.has(item.key),
  );
  return (
    <section
      className="list-panel agent-cloning"
      aria-labelledby="agent-cloning-title"
    >
      <div className="list-toolbar">
        <div>
          <h2 id="agent-cloning-title">Copy MCPs from your agents</h2>
          <p className="muted">
            Select source agents and MCPs. Their configuration stays unchanged.
          </p>
        </div>
        <div className="actions">
          <button disabled={disabled || busy} onClick={() => void scan()}>
            Scan agents
          </button>
          {!busy && (
            <button onClick={() => (expanded ? dismiss() : setExpanded(true))}>
              {expanded ? 'Dismiss' : 'Review agent MCPs'}
            </button>
          )}
          {busy && job && (
            <button
              onClick={() =>
                void api(`/api/agent-cloning/${job.id}/cancel`, {}).catch(() =>
                  setError(
                    'Cancellation was not confirmed. Keep checking the outcome.',
                  ),
                )
              }
            >
              Cancel import
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="clone-content">
          {busy && (
            <p role="status">
              {job?.phase ?? 'scanning'}… Saved copies:{' '}
              {job?.results.filter((item) => item.connectorId).length ?? 0}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {job && (
            <>
              <p>
                Available credentials are copied into the protected Hub store.
                Credential values never appear here. OAuth or missing references
                may need a new sign-in. Connecting agents to the Hub is a
                separate action in Agents.
              </p>
              {job.truncated && (
                <p className="notice">
                  This scan reached 256 entries. Import these first, then review
                  additional source configurations separately.
                </p>
              )}
              <div className="actions">
                <button
                  disabled={busy || disabled}
                  onClick={() =>
                    toggle(
                      available.map((item) => item.key),
                      true,
                    )
                  }
                >
                  Select all MCPs
                </button>
                <button
                  disabled={busy || disabled}
                  onClick={() => toggle([...selected], false)}
                >
                  Deselect all
                </button>
              </div>
              {job.agents.map((agent) => {
                const entries = candidates.filter(
                    (item) => item.agentId === agent.agentId,
                  ),
                  eligible = entries.filter(
                    (item) =>
                      item.state !== 'needs_setup' && !saved.has(item.key),
                  );
                return (
                  <details key={agent.agentId} open className="clone-agent">
                    <summary>
                      {agent.name} · {entries.length} MCPs · {agent.state}
                    </summary>
                    {!!eligible.length && (
                      <label className="clone-select-agent">
                        <input
                          type="checkbox"
                          disabled={busy || disabled}
                          checked={eligible.every((item) =>
                            selected.has(item.key),
                          )}
                          onChange={(event) =>
                            toggle(
                              eligible.map((item) => item.key),
                              event.target.checked,
                            )
                          }
                        />
                        Select MCPs from {agent.name}
                      </label>
                    )}
                    <ul className="clone-entries">
                      {entries.map((item) => (
                        <li key={item.key}>
                          <label>
                            <input
                              type="checkbox"
                              aria-label={`Copy ${item.name} from ${agent.name}`}
                              disabled={
                                busy ||
                                disabled ||
                                item.state === 'needs_setup' ||
                                saved.has(item.key)
                              }
                              checked={
                                selected.has(item.key) && !saved.has(item.key)
                              }
                              onChange={(event) =>
                                toggle([item.key], event.target.checked)
                              }
                            />
                            <strong>{item.name}</strong>
                          </label>
                          <span className="pill">
                            {saved.has(item.key)
                              ? 'Saved'
                              : item.state.replaceAll('_', ' ')}
                          </span>
                          {!item.enabled && (
                            <span className="pill">
                              Disabled in source · copied disabled
                            </span>
                          )}
                          {item.existing && (
                            <span className="pill warn">
                              Name already in Hub · choose a copy name
                            </span>
                          )}
                          <small>
                            {item.credentialCount} credential bindings
                            {item.missing.length
                              ? ` · Missing: ${item.missing.join(', ')}`
                              : ''}
                          </small>
                          {item.issues.includes('package_changed') && (
                            <p className="notice">
                              The package dependency snapshot changed. Review
                              and approve its updated details before retrying.
                            </p>
                          )}
                          {item.issues.includes('package_lookup_failed') && (
                            <p className="notice">
                              Package details could not be loaded. Review
                              selected packages again to retry.
                            </p>
                          )}
                          {item.state === 'needs_setup' ? (
                            <p>
                              Needs setup: {item.issues.join(', ')}.{' '}
                              <button
                                onClick={openManual}
                                disabled={busy || disabled}
                              >
                                Configure manually
                              </button>
                            </p>
                          ) : (
                            <>
                              <label>
                                Destination name
                                <input
                                  aria-label={`Destination name for ${item.name} from ${agent.name}`}
                                  value={names[item.key] ?? item.name}
                                  maxLength={100}
                                  disabled={
                                    busy || disabled || saved.has(item.key)
                                  }
                                  onChange={(event) => {
                                    setNames({
                                      ...names,
                                      [item.key]: event.target.value,
                                    });
                                    setReviewed(false);
                                  }}
                                />
                              </label>
                              <details>
                                <summary>Review execution definition</summary>
                                <pre>
                                  {JSON.stringify(
                                    item.definition ?? item.packageProposal,
                                    null,
                                    2,
                                  )}
                                </pre>
                              </details>
                              {item.packageProposal && (
                                <div className="clone-package">
                                  {item.packagePreview ? (
                                    <>
                                      <p>
                                        Install {item.packagePreview.name}@
                                        {item.packagePreview.version} ·{' '}
                                        {item.packagePreview.packageCount}{' '}
                                        packages. Install scripts are disabled.
                                      </p>
                                      <label>
                                        Package command
                                        <select
                                          aria-label={`Package command for ${item.name}`}
                                          value={bins[item.key] ?? ''}
                                          disabled={
                                            busy ||
                                            disabled ||
                                            saved.has(item.key)
                                          }
                                          onChange={(event) => {
                                            setBins({
                                              ...bins,
                                              [item.key]: event.target.value,
                                            });
                                            setReviewed(false);
                                          }}
                                        >
                                          <option value="">
                                            Choose command
                                          </option>
                                          {item.packagePreview.entries.map(
                                            (entry) => (
                                              <option
                                                key={entry.entry}
                                                value={entry.entry}
                                              >
                                                {entry.entry}
                                              </option>
                                            ),
                                          )}
                                        </select>
                                      </label>
                                      <ul>
                                        {item.packagePreview.warnings.map(
                                          (warning) => (
                                            <li key={warning}>
                                              {warning.replaceAll('_', ' ')}
                                            </li>
                                          ),
                                        )}
                                      </ul>
                                    </>
                                  ) : (
                                    <p>
                                      Review package details before copying.
                                      This lookup downloads metadata, without
                                      installing or starting the MCP.
                                    </p>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
              {choices.some((item) => item.packageProposal) && (
                <button
                  disabled={busy || disabled || !choices.length}
                  onClick={() =>
                    void action(`/api/agent-cloning/${job.id}/prepare`, {
                      keys: choices.map((item) => item.key),
                    })
                  }
                >
                  Review selected packages
                </button>
              )}
              <label className="clone-consent">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={
                    busy || disabled || !choices.length || needsPackages
                  }
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I reviewed the selected commands, endpoints, credential copying,
                package downloads and all listed package warnings. I approve
                execution of these copies.
              </label>
              {distinct.size !== choices.length && (
                <p role="alert">
                  Selected copies need different destination names.
                </p>
              )}
              <button
                disabled={
                  busy ||
                  disabled ||
                  !choices.length ||
                  !reviewed ||
                  needsPackages ||
                  distinct.size !== choices.length ||
                  choices.some(
                    (item) =>
                      !names[item.key]?.trim() ||
                      (item.packageProposal && !bins[item.key]),
                  )
                }
                onClick={() =>
                  void action(`/api/agent-cloning/${job.id}/copy`, {
                    expectedRevision: job.expectedRevision,
                    copyCredentials: true,
                    approveExecution: true,
                    entries: choices.map((item) => ({
                      key: item.key,
                      name: names[item.key],
                      ...(item.packageProposal
                        ? {
                            entry: bins[item.key],
                            previewId: item.packagePreview!.previewId,
                            acknowledgedWarnings: item.packagePreview!.warnings,
                          }
                        : {}),
                    })),
                  })
                }
              >
                Clone and connect ({choices.length})
              </button>
              {!!job.results.length && (
                <div role="status">
                  <p>
                    Saved copies remain in Connectors. Tools load automatically
                    after successful discovery. Use Authentication or Edit there
                    to repair failed connections.
                  </p>
                  <ul>
                    {job.results.map((result) => (
                      <li key={result.key}>
                        {
                          candidates.find((item) => item.key === result.key)
                            ?.name
                        }
                        : {result.state.replaceAll('_', ' ')}
                        {result.connectorId ? ` · ${result.connectorId}` : ''}
                      </li>
                    ))}
                  </ul>
                  <button disabled={busy} onClick={dismiss}>
                    Finish
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
