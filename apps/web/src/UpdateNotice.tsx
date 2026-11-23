import { useEffect, useState } from 'react';
import { UpdateStatusSchema, type UpdateStatus } from '@waleed/contracts';
import { api } from './api.js';
export interface UpdateCheck {
  status: UpdateStatus | null;
  busy: boolean;
  error: boolean;
  check: () => Promise<void>;
}

// The release check. It runs once when the hub offers it and then every hour,
// and the shell reads its status for the count on Settings, so it lives above
// the notice and keeps running while the notice is hidden.
export function useUpdateCheck(enabled: boolean): UpdateCheck {
  const [status, setStatus] = useState<UpdateStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    const refresh = () =>
      void api('/api/updates/check', {})
        .then((value) => {
          if (mounted) {
            setStatus(UpdateStatusSchema.parse(value));
            setError(false);
          }
        })
        .catch(() => {
          if (mounted) setError(true);
        });
    refresh();
    const timer = window.setInterval(refresh, 3_600_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [enabled]);
  async function check() {
    setBusy(true);
    setError(false);
    try {
      setStatus(UpdateStatusSchema.parse(await api('/api/updates/check', {})));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return { status, busy, error, check };
}

export function UpdateNotice({ status, busy, error, check }: UpdateCheck) {
  return (
    <aside className="update-notice" aria-label="Application releases">
      <div role="status">
        {status && <span>Version {status.currentVersion}. </span>}
        {status?.state === 'available' ? (
          <>
            <strong>Version {status.latestVersion} is available.</strong>{' '}
            <a
              href={status.downloadUrl!}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download update
            </a>
            {' · '}
            <a
              href={status.releaseUrl!}
              target="_blank"
              rel="noopener noreferrer"
            >
              Release notes
            </a>
          </>
        ) : (
          <span>
            {error || status?.state === 'unavailable'
              ? 'Update check unavailable. Local MCP management is unaffected.'
              : status?.state === 'current'
                ? 'Latest published version checked.'
                : 'Checking GitHub releases…'}
          </span>
        )}
        {status?.checkedAt && (
          <small>
            {' '}
            Last checked {new Date(status.checkedAt).toLocaleString()}.
          </small>
        )}
      </div>
      <button disabled={busy} onClick={() => void check()}>
        {busy ? 'Checking…' : 'Check updates'}
      </button>
    </aside>
  );
}
