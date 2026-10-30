import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AuthJob,
  CredentialWrite,
  NativeSecretAdapter,
} from '@waleed/contracts';
import type { ManagedConnector } from './ConnectorList.js';
import { api } from './api.js';
import { Icon } from './Icon.js';

interface AuthStatus {
  nativeAdapter?: NativeSecretAdapter;
  genericOAuthSupported?: boolean;
  credentials: Array<{
    id: string;
    adapter: string;
    present: boolean;
    kind: string;
  }>;
  recipes: Array<{
    id: string;
    name: string;
    issuer: string;
    scopes: string[];
  }>;
  state: string;
}
interface OAuthDiscovery {
  discoveryHash: string;
  issuer: string;
  resource: string;
  scopes: string[];
  revocationSupported: boolean;
}
interface ConnectedAccount {
  connectorId: string;
  recipeId: string;
  issuer: string | null;
  scopes: string[];
  refreshSupported: boolean;
  revocationSupported: boolean;
}
export function AuthDialog({
  connector,
  revision,
  close,
  refresh,
}: {
  connector: ManagedConnector;
  revision: number;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    form = useRef<HTMLFormElement>(null),
    secret = useRef<HTMLInputElement>(null),
    mounted = useRef(true),
    currentJob = useRef<AuthJob | null>(null);
  const [status, setStatus] = useState<AuthStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [deleted, setDeleted] = useState(false),
    [job, setJob] = useState<AuthJob | null>(null),
    [consent, setConsent] = useState(false);
  const [discovery, setDiscovery] = useState<OAuthDiscovery | null>(null),
    [scopes, setScopes] = useState<string[]>([]),
    [genericConsent, setGenericConsent] = useState(false),
    [account, setAccount] = useState<ConnectedAccount | null>(null),
    [disconnectConsent, setDisconnectConsent] = useState(false),
    [accountNotice, setAccountNotice] = useState('');
  const [unused, setUnused] = useState<
      Array<{ id: string; present: boolean; ownerIds: string[] }>
    >([]),
    [deleteConsent, setDeleteConsent] = useState(false);
  const approved =
    connector.enabled &&
    connector.trustApproval?.revision === connector.revision &&
    connector.trustApproval.definitionHash === connector.executionHash;
  const load = async () => {
    const [info, credentials, accounts] = await Promise.all([
      api<AuthStatus>(`/api/connectors/${connector.id}/auth`),
      api<{
        references: Array<{ id: string; present: boolean; ownerIds: string[] }>;
      }>('/api/credentials'),
      api<{ accounts: ConnectedAccount[] }>('/api/oauth/accounts'),
    ]);
    if (mounted.current) {
      setStatus(info);
      setAccount(
        accounts.accounts.find((item) => item.connectorId === connector.id) ??
          null,
      );
      setUnused(
        credentials.references.filter(
          (reference) => reference.present && !reference.ownerIds.length,
        ),
      );
    }
  };
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void load().catch(() => {
      if (mounted.current) setError('Authentication metadata is unavailable.');
    });
    return () => {
      mounted.current = false;
      form.current?.reset();
      if (secret.current) secret.current.value = '';
      const current = currentJob.current;
      if (current && !current.completedAt)
        void api(`/api/auth/jobs/${current.id}/cancel`, {}).catch(
          () => undefined,
        );
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function dismiss() {
    form.current?.reset();
    if (secret.current) secret.current.value = '';
    try {
      if (currentJob.current && !currentJob.current.completedAt)
        await api(`/api/auth/jobs/${currentJob.current.id}/cancel`, {});
      close();
    } catch {
      setError(
        'Inputs cleared, but cancellation could not be confirmed. Retry Cancel or wait for the bounded job timeout.',
      );
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form.current || !secret.current || !status) return;
    setBusy(true);
    setError('');
    const fields = new FormData(form.current);
    const input: CredentialWrite = {
      expectedRevision: revision,
      expectedConnectorRevision: connector.revision,
      location: connector.executionMode === 'remote' ? 'header' : 'environment',
      adapter:
        connector.executionMode === 'docker'
          ? 'docker'
          : (status?.nativeAdapter ?? 'windows'),
      name: String(fields.get('binding')),
      format:
        connector.executionMode === 'remote'
          ? (fields.get('format') as CredentialWrite['format'])
          : 'raw',
      value: secret.current.value,
    };
    secret.current.value = '';
    fields.delete('credential');
    try {
      await api(`/api/connectors/${connector.id}/credentials`, input);
      if (mounted.current) setSaved(true);
      await refresh();
      await load();
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Credential save failed.',
        );
    } finally {
      input.value = '';
      if (secret.current) secret.current.value = '';
      if (mounted.current) setBusy(false);
    }
  }
  async function signIn(recipeId: string, refreshToken = false) {
    if (secret.current) secret.current.value = '';
    setBusy(true);
    setError('');
    try {
      let current = await api<AuthJob>(
        `/api/connectors/${connector.id}/oauth${refreshToken ? '/refresh' : ''}`,
        {
          expectedRevision: revision,
          expectedConnectorRevision: connector.revision,
          recipeId,
          definitionHash: connector.executionHash,
          approveSignInAndDiscovery: true,
          ...(recipeId === 'generic' && !refreshToken
            ? { discoveryHash: discovery?.discoveryHash, scopes }
            : {}),
        },
      );
      currentJob.current = current;
      if (mounted.current) setJob(current);
      const deadline = Date.now() + 130_000;
      while (!current.completedAt && mounted.current && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        if (!mounted.current) return;
        current = await api<AuthJob>(`/api/auth/jobs/${current.id}`);
        currentJob.current = current;
        setJob(current);
      }
      await refresh();
      if (mounted.current) await load();
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : 'Sign-in failed.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function discover() {
    if (secret.current) secret.current.value = '';
    setBusy(true);
    setError('');
    setGenericConsent(false);
    setDiscovery(null);
    try {
      const result = await api<OAuthDiscovery>(
        `/api/connectors/${connector.id}/oauth/discover`,
        {
          expectedRevision: revision,
          expectedConnectorRevision: connector.revision,
          definitionHash: connector.executionHash,
          approveDiscovery: true,
        },
      );
      if (mounted.current) {
        setDiscovery(result);
        setScopes(result.scopes);
      }
    } catch {
      if (mounted.current)
        setError(
          'Standard OAuth discovery is unavailable. This server may require a provider-specific client or unsupported authorization flow.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function disconnect(revokeProvider: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ providerRevoked: boolean }>(
        `/api/connectors/${connector.id}/oauth/disconnect`,
        {
          expectedRevision: revision,
          expectedConnectorRevision: connector.revision,
          confirmDisconnect: true,
          revokeProvider,
        },
      );
      if (mounted.current)
        setAccountNotice(
          result.providerRevoked
            ? 'Provider tokens revoked and local account disconnected. Approve the connector again before using it.'
            : 'Local account disconnected. Provider access was not revoked; remove authorization in the provider settings.',
        );
      await refresh();
      await load();
    } catch {
      if (mounted.current)
        setError(
          'Disconnect failed. Provider access may have changed; inspect account settings and Hub recovery before retrying.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const consumed = saved || deleted || !!accountNotice || !!job?.completedAt;
  return (
    <dialog
      ref={dialog}
      className="import-dialog auth-dialog"
      aria-labelledby="auth-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy || job) void dismiss();
      }}
    >
      <div className="dialog-header">
        <div className="eyebrow">ONE-WAY CREDENTIALS</div>
        <button
          className="icon-button"
          aria-label="Close authentication dialog"
          disabled={busy && !job}
          onClick={() => {
            void dismiss();
          }}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="auth-title">Authentication — {connector.name}</h2>
      <p className="muted">
        Values are write-only. Responses, exports and agent settings contain
        references, never credentials. Saving is not authentication
        verification.
      </p>
      <p>
        Store:{' '}
        {connector.executionMode === 'docker'
          ? 'Docker OS keychain (stdin)'
          : status?.nativeAdapter === 'keychain'
            ? 'macOS Keychain — current user'
            : status?.nativeAdapter === 'libsecret'
              ? 'Linux Secret Service / libsecret — current user'
              : 'Windows DPAPI — current user'}
        . Existing credential values are never displayed.
      </p>
      {!!status?.credentials.length && (
        <ul>
          {status.credentials.map((credential) => (
            <li key={credential.id}>
              {credential.id} · {credential.present ? 'present' : 'missing'} ·{' '}
              {credential.kind}
            </li>
          ))}
        </ul>
      )}
      {deleted && (
        <p role="status" className="notice">
          Local credential deleted. Provider access was not revoked.
        </p>
      )}
      {accountNotice && (
        <p role="status" className="notice">
          {accountNotice}
        </p>
      )}
      {saved && (
        <p role="status" className="notice">
          Credential saved, not verified. Close this dialog, approve the new
          definition and run Test capabilities. The previous credential is
          retained until explicitly deleted.
        </p>
      )}
      {!consumed && !job && (
        <form
          ref={form}
          className="form-fields"
          onSubmit={(event) => {
            void save(event);
          }}
          autoComplete="off"
        >
          <label htmlFor="credential-binding">
            {connector.executionMode === 'remote'
              ? 'Credential header'
              : 'Credential environment variable'}
          </label>
          <input
            id="credential-binding"
            name="binding"
            defaultValue={
              connector.executionMode === 'remote'
                ? 'Authorization'
                : 'PROVIDER_TOKEN'
            }
            required
            maxLength={100}
            spellCheck={false}
          />
          {connector.executionMode === 'remote' && (
            <>
              <label htmlFor="credential-format">Header format</label>
              <select id="credential-format" name="format" defaultValue="raw">
                <option value="raw">
                  Exact value (API key / custom header)
                </option>
                <option value="bearer">Bearer token (prefix added)</option>
                <option value="basic">
                  Basic (provide base64 user:password)
                </option>
              </select>
              <p className="muted">
                Use the provider's documented header and format. Bearer is never
                assumed.
              </p>
            </>
          )}
          <label htmlFor="credential-value">New credential value</label>
          <input
            ref={secret}
            id="credential-value"
            name="credential"
            type="password"
            autoComplete="new-password"
            maxLength={8192}
            spellCheck={false}
            required
            aria-describedby="credential-help"
          />
          <p id="credential-help" className="muted">
            Cleared on submission, error and close. No show/copy/export action
            is provided.
          </p>
          <button type="submit" className="primary" disabled={busy || !status}>
            {busy && !job ? 'Saving…' : 'Save protected credential'}
          </button>
        </form>
      )}
      <section className="review">
        <h3>Connected OAuth account</h3>
        {account ? (
          <>
            <p>
              {account.issuer ?? 'OAuth provider'} ·{' '}
              {account.scopes.join(', ') || 'No recorded scopes'}
            </p>
            <p className="muted">
              {account.refreshSupported
                ? 'Tokens refresh automatically before remote requests.'
                : 'No refresh token was issued; sign in again when access expires.'}
            </p>
            {!consumed && (
              <>
                <label className="import-check">
                  <input
                    type="checkbox"
                    checked={disconnectConsent}
                    onChange={(event) =>
                      setDisconnectConsent(event.target.checked)
                    }
                  />
                  I confirm this account should be disconnected.
                </label>
                <div className="row-actions">
                  <button
                    disabled={
                      busy || !disconnectConsent || !account.revocationSupported
                    }
                    onClick={() => void disconnect(true)}
                  >
                    Revoke and disconnect
                  </button>
                  <button
                    disabled={busy || !disconnectConsent}
                    onClick={() => void disconnect(false)}
                  >
                    Disconnect locally only
                  </button>
                  <button
                    disabled={busy || !approved || !account.refreshSupported}
                    onClick={() => void signIn(account.recipeId, true)}
                  >
                    Refresh account token
                  </button>
                </div>
                {!account.revocationSupported && (
                  <p className="muted">
                    Provider revocation is not advertised. Local disconnect does
                    not revoke provider access.
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <p>No connected OAuth account.</p>
        )}
      </section>
      {status?.genericOAuthSupported && !consumed && !job && (
        <section className="review">
          <h3>Standard MCP OAuth</h3>
          <p>
            Discover authorization metadata from this approved remote endpoint.
            No credentials are sent during discovery.
          </p>
          <button disabled={busy || !approved} onClick={() => void discover()}>
            {busy ? 'Working…' : 'Discover OAuth provider'}
          </button>
          {!approved && (
            <p className="notice">
              Approve the enabled execution definition before discovery.
            </p>
          )}
          {discovery && (
            <>
              <p>
                Issuer: <code>{discovery.issuer}</code>
              </p>
              <p>
                Resource: <code>{discovery.resource}</code>
              </p>
              <fieldset disabled={busy}>
                <legend>Requested scopes</legend>
                {discovery.scopes.length ? (
                  discovery.scopes.map((scope) => (
                    <label key={scope} className="import-check">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={(event) => {
                          setScopes((current) =>
                            event.target.checked
                              ? [...current, scope]
                              : current.filter((value) => value !== scope),
                          );
                          setGenericConsent(false);
                        }}
                      />
                      {scope}
                    </label>
                  ))
                ) : (
                  <p>
                    No scopes advertised. Review permissions on the provider
                    consent page.
                  </p>
                )}
              </fieldset>
              <label className="import-check">
                <input
                  type="checkbox"
                  checked={genericConsent}
                  disabled={busy}
                  onChange={(event) => setGenericConsent(event.target.checked)}
                />
                I approve this issuer, selected scopes and MCP capability
                discovery.
              </label>
              <button
                disabled={busy || !approved || !genericConsent}
                onClick={() => void signIn('generic')}
              >
                Sign in with discovered provider
              </button>
            </>
          )}
        </section>
      )}
      <section className="review">
        <h3>Supported OAuth</h3>
        {!status?.recipes.length ? (
          <p>
            No curated OAuth recipe for this endpoint. Remote servers can use
            standard MCP OAuth discovery above; arbitrary login webpages are not
            supported.
          </p>
        ) : (
          status.recipes.map((recipe) => (
            <div key={recipe.id}>
              <p>
                {recipe.name} · {recipe.issuer}
              </p>
              <p>
                Requested scopes: {recipe.scopes.join(', ')}. Tokens are
                protected locally; only MCP discovery runs after consent.
              </p>
              {!consumed && (
                <>
                  <label className="import-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(event) => setConsent(event.target.checked)}
                    />
                    I approve this provider, scope and capability discovery.
                  </label>
                  <div className="row-actions">
                    <button
                      disabled={busy || !consent || !approved}
                      onClick={() => {
                        void signIn(recipe.id);
                      }}
                    >
                      Sign in and verify
                    </button>
                    <button
                      disabled={
                        busy ||
                        !consent ||
                        !approved ||
                        !status.credentials.some(
                          (reference) => reference.kind === 'oauth',
                        )
                      }
                      onClick={() => {
                        void signIn(recipe.id, true);
                      }}
                    >
                      Refresh supported token
                    </button>
                  </div>
                  {!approved && (
                    <p className="notice">
                      Approve the enabled execution definition before sign-in
                      and discovery.
                    </p>
                  )}
                </>
              )}
            </div>
          ))
        )}
        {job && (
          <div role="status">
            <p>
              Sign-in: {job.state.replaceAll('_', ' ')} ·{' '}
              {job.reason.replaceAll('_', ' ')}
            </p>
            {job.authorizationUrl && (
              <a
                href={job.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Continue to verified provider
              </a>
            )}
            {job.state === 'succeeded' && (
              <p>MCP discovery passed. No upstream tool was called.</p>
            )}
            {job.completedAt && job.state !== 'succeeded' && (
              <p>
                Not verified. Cancellation does not revoke a provider grant;
                credentials saved before a later failure may remain protected
                locally.
              </p>
            )}
          </div>
        )}
      </section>
      {!!unused.length && (
        <details>
          <summary>Unused local credential references</summary>
          <p>
            Deleting local data does not revoke provider access. Old
            materialized consumers must be removed first.
          </p>
          <label className="import-check">
            <input
              type="checkbox"
              checked={deleteConsent}
              onChange={(event) => setDeleteConsent(event.target.checked)}
            />
            I confirm local deletion, not provider revocation.
          </label>
          {unused.map((reference) => (
            <p key={reference.id}>
              {reference.id}{' '}
              <button
                disabled={busy || !deleteConsent || consumed}
                onClick={() => {
                  setBusy(true);
                  void api(`/api/credentials/${reference.id}/delete`, {
                    expectedRevision: revision,
                    confirmLocalDeletion: true,
                  })
                    .then(async () => {
                      setDeleted(true);
                      await refresh();
                      await load();
                    })
                    .catch(() =>
                      setError(
                        'Deletion refused or unavailable. Inspect references and recovery.',
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Delete local credential
              </button>
            </p>
          ))}
        </details>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <footer className="dialog-footer">
        <button
          disabled={busy && !job}
          onClick={() => {
            void dismiss();
          }}
        >
          {job && !job.completedAt ? 'Cancel sign-in' : 'Close'}
        </button>
      </footer>
    </dialog>
  );
}
