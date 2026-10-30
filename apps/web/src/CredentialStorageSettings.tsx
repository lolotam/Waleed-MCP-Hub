import { useEffect, useState } from 'react';
import {
  CredentialStorageStatusSchema,
  type CredentialStorageStatus,
} from '@waleed/contracts';
import { api } from './api.js';

export function CredentialStorageSettings() {
  const [status, setStatus] = useState<CredentialStorageStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api('/api/credential-storage')
      .then((result) => {
        if (active) setStatus(CredentialStorageStatusSchema.parse(result));
      })
      .catch(() => {
        if (active) setError('Credential storage diagnostics are unavailable.');
      });
    return () => {
      active = false;
    };
  }, []);
  async function check() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setStatus(
        CredentialStorageStatusSchema.parse(
          await api('/api/credential-storage/check', {}),
        ),
      );
    } catch {
      setError(
        'Credential storage check was not confirmed. No plaintext fallback is enabled.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="list-panel integration-guidance"
      aria-labelledby="credential-storage-title"
    >
      <h2 id="credential-storage-title">Credential storage & containment</h2>
      {status ? (
        <>
          <p>
            <strong>{status.name}</strong> ·{' '}
            {
              {
                not_checked: 'Not checked',
                available: 'Available',
                unavailable: 'Unavailable — locked, denied or missing',
                not_configured: 'Not configured in this runtime',
              }[status.state]
            }
          </p>
          <p>
            {status.containment === 'windows-job-object'
              ? 'Native execution uses Windows JobObject containment.'
              : status.containment === 'posix-process-group'
                ? 'Native execution uses owned POSIX process groups. This is cleanup, not a security sandbox; detached descendants can escape the group.'
                : 'No reviewed process containment adapter is available.'}
          </p>
          {status.checkedAt && (
            <p>Last check: {new Date(status.checkedAt).toLocaleString()}</p>
          )}
        </>
      ) : (
        <p>Loading credential storage diagnostics…</p>
      )}
      <p>
        Checks access only when requested and may invoke the OS keyring UI. A
        failed or locked keyring never falls back to a plaintext file. No
        credentials are added by this check.
      </p>
      <button
        disabled={busy || !status || status.state === 'not_configured'}
        onClick={() => void check()}
      >
        {busy ? 'Checking credential storage…' : 'Check credential storage'}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
