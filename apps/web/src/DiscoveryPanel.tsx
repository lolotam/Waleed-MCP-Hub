import { useEffect, useRef, useState } from 'react';
import type {
  AdoptionPreview,
  DiscoveryJob,
  DiscoverySnapshot,
} from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';

export function DiscoveryPanel({
  snapshot,
  preview,
  refresh,
}: {
  snapshot: DiscoverySnapshot | null;
  preview: AdoptionPreview | null;
  refresh: () => Promise<unknown>;
}) {
  const [job, setJob] = useState<DiscoveryJob | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const dependencyHelp = {
    none: '',
    docker_missing:
      'Install Docker Desktop separately, then scan again. Nothing is installed automatically.',
    remote_context_not_allowed:
      'Select a local Docker Desktop named-pipe context. Remote Docker contexts are deliberately not probed.',
    engine_unavailable:
      'Start Docker Desktop and wait for its engine, then scan again.',
    gateway_unavailable:
      'The Docker MCP plugin could not be read. Check its local installation before retrying.',
    unsupported_gateway:
      'This gateway version has not been verified. No profile adapter fallback was attempted.',
    invalid_output:
      'Dependency output did not match the supported format. Nothing was imported.',
    probe_failed:
      'The dependency could not be probed through the constrained native runner.',
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function discover() {
    setBusy(true);
    setError('');
    try {
      let current = await api<DiscoveryJob>('/api/discovery', {});
      setJob(current);
      while (['queued', 'running'].includes(current.state) && mounted.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        current = await api<DiscoveryJob>(`/api/discovery/jobs/${current.id}`);
        if (mounted.current) setJob(current);
      }
      if (!mounted.current) return;
      if (current.state === 'failed')
        setError(
          'Discovery did not complete. Previous observations were retained. Check local dependencies and try again.',
        );
      await refresh();
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'The read-only scan failed.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!job) return;
    try {
      setJob(
        await api<DiscoveryJob>(`/api/discovery/jobs/${job.id}/cancel`, {}),
      );
    } catch {
      setError(
        'Cancellation could not be confirmed. Refresh the view before starting another scan.',
      );
    }
  }
  return (
    <section
      className="list-panel discovery-panel"
      aria-labelledby="discovery-title"
    >
      <div className="list-toolbar">
        <div>
          <h2 id="discovery-title">Environment discovery</h2>
          <p className="muted discovery-summary">
            {snapshot?.checkedAt
              ? `Docker: ${snapshot.docker.state} · ${snapshot.agents.filter((agent) => agent.detected).length}/8 CLI targets found · checked ${new Date(snapshot.checkedAt).toLocaleString()}`
              : 'Not scanned. No personal configurations have been inspected by this view.'}
          </p>
        </div>
        <div className="discovery-actions">
          <button
            disabled={busy}
            onClick={() => {
              void discover();
            }}
          >
            <Icon name="search" size={16} />
            {busy
              ? 'Scanning…'
              : snapshot?.checkedAt
                ? 'Scan again'
                : 'Discover environment'}
          </button>
          {busy && (
            <button
              onClick={() => {
                void cancel();
              }}
            >
              Cancel scan
            </button>
          )}
        </div>
      </div>
      {snapshot?.mode === 'fixture' && (
        <p className="discovery-note notice" role="status">
          Synthetic discovery fixture — not your installed environment.
        </p>
      )}
      {job && (
        <p className="discovery-note muted" role="status">
          Scan {job.state} · {job.phase.replaceAll('_', ' ')}
          {job.reason !== 'none' ? ` · ${job.reason.replaceAll('_', ' ')}` : ''}
        </p>
      )}
      {error && (
        <p className="discovery-note error-message" role="alert">
          {error}
        </p>
      )}
      {snapshot?.checkedAt && snapshot.docker.reason !== 'none' && (
        <p className="discovery-note notice" role="status">
          {dependencyHelp[snapshot.docker.reason]}
        </p>
      )}
      <details className="discovery-details">
        <summary>Review existing pilot — read-only adoption preview</summary>
        {!snapshot?.checkedAt ? (
          <p>
            Run discovery first. It uses installed-package metadata, bounded
            configuration reads, and allowlisted local Docker queries. It does
            not start agents, gateways, native connectors, or upstream tools.
          </p>
        ) : (
          <>
            <p>
              Pilot: <strong>{snapshot.pilot.state}</strong> · source file:{' '}
              <strong>{snapshot.pilot.sourceStatus}</strong> · source metadata
              comparison: <strong>{snapshot.pilot.drift}</strong> ·{' '}
              {snapshot.pilot.unmatchedSourceCount} unmatched source entries ·
              Chrome configured isolation:{' '}
              <strong>
                {snapshot.pilot.chrome.isolation.replaceAll('_', ' ')}
              </strong>{' '}
              · native package:{' '}
              {snapshot.pilot.chrome.packagePinned
                ? 'version pinned'
                : 'not version pinned'}
            </p>
            <p className="muted">
              This is a snapshot, not a live health check. User-file bindings do
              not prove effective project/account configuration. Existing
              provider authentication problems, including the pilot’s Postora
              issue, are not fixed by discovery.
            </p>
            {preview && (
              <>
                <p>
                  Registry revision {preview.expectedRevision} ·{' '}
                  {preview.candidates.length} observed candidates · apply not
                  supported
                </p>
                {preview.conflicts.length > 0 && (
                  <p className="notice">
                    Review required:{' '}
                    {preview.conflicts
                      .map((conflict) => conflict.replaceAll('_', ' '))
                      .join('; ')}
                    .
                  </p>
                )}
                <ul className="discovery-candidates">
                  {preview.candidates.map((candidate) => (
                    <li key={candidate.id}>
                      <strong>{candidate.name}</strong>
                      <span>
                        {candidate.executionMode} ·{' '}
                        {candidate.origin ?? 'local runtime'} ·{' '}
                        {candidate.secretBindingCount} binding declarations ·
                        not tested
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  No credential values are copied. Unknown source/profile
                  mappings and launcher recipes need manual comparison.
                  Recognizing a recipe is not execution approval; a shared
                  gateway snapshot is not automatically refreshed from source
                  files.
                </p>
              </>
            )}
          </>
        )}
        <div className="discovery-actions">
          <button disabled aria-describedby="adoption-help">
            Apply adoption
          </button>
          <span id="adoption-help" className="muted">
            Disabled until safe normalization, execution approval, and runtime
            adapters are implemented.
          </span>
        </div>
      </details>
    </section>
  );
}
