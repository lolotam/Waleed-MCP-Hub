import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ClientTokensListSchema,
  CreatedClientTokenSchema,
  IntegrationAgentIdSchema,
  type ClientToken,
  type Profile,
} from '@waleed/contracts';
import { api } from './api.js';

export function HttpEndpoints({
  profiles,
  blocked,
}: {
  profiles: Profile[];
  blocked: boolean;
}) {
  const [list, setList] = useState<{
    revision: number;
    tokens: ClientToken[];
  } | null>(null);
  const [open, setOpen] = useState(false),
    [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    pending = useRef(false),
    mounted = useRef(true),
    wasOpen = useRef(false);
  const endpoint = `${window.location.origin}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        'waleed-mcp-hub': {
          url: endpoint,
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    },
    null,
    2,
  );
  async function load() {
    const result = ClientTokensListSchema.parse(await api('/api/http-tokens'));
    if (mounted.current) setList(result);
  }
  useEffect(() => {
    mounted.current = true;
    void load().catch(() => {
      if (mounted.current)
        setError('Client tokens could not be loaded. Refresh to retry.');
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!secret) return;
    const timer = setTimeout(() => setSecret(''), 5 * 60_000);
    const clear = () => setSecret('');
    window.addEventListener('pagehide', clear);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pagehide', clear);
    };
  }, [secret]);
  function dismiss() {
    setSecret('');
    setOpen(false);
    setNotice('');
  }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!list || blocked || pending.current) return;
    const data = new FormData(event.currentTarget);
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = CreatedClientTokenSchema.parse(
        await api('/api/http-tokens', {
          expectedRevision: list.revision,
          label: String(data.get('label') ?? ''),
          agentId: String(data.get('agentId') ?? 'http-client'),
          ...(data.get('profileId')
            ? { profileId: String(data.get('profileId')) }
            : {}),
          ...(data.get('expiry') === '30d'
            ? {
                expiresAt: new Date(
                  Date.now() + 30 * 24 * 60 * 60_000,
                ).toISOString(),
              }
            : {}),
        }),
      );
      if (mounted.current) {
        setSecret(result.plaintextToken);
        setList({
          ...list,
          revision: result.revision,
          tokens: [...list.tokens, result.token],
        });
      }
    } catch {
      setError(
        'Token generation was not confirmed. Refresh the list before retrying; revoke any unwanted token.',
      );
      await load().catch(() => undefined);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function revoke(token: ClientToken) {
    if (!list || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setSecret('');
    try {
      const result = ClientTokensListSchema.parse(
        await api(
          `/api/http-tokens/${token.id}`,
          { expectedRevision: list.revision },
          'DELETE',
        ),
      );
      if (mounted.current) {
        setList(result);
        setNotice(
          `Access revoked for ${token.label}. Its MCP sessions are closed.`,
        );
      }
    } catch {
      setError(
        'Revocation was not confirmed on disk. Refresh and retry before assuming access is permanently revoked.',
      );
      await load().catch(() => undefined);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(
        `${what} copied. Store it securely; the clipboard is outside the Hub.`,
      );
    } catch {
      setError(
        'Clipboard access was denied. Select and copy the displayed value manually.',
      );
    }
  }
  return (
    <section
      className="list-panel integration-guidance http-endpoints"
      aria-labelledby="http-endpoint-title"
    >
      <div className="list-toolbar">
        <div>
          <h2 id="http-endpoint-title">HTTP endpoint</h2>
          <p>Streamable HTTP · loopback only · one token per client</p>
        </div>
        <button
          ref={trigger}
          className="primary"
          disabled={blocked || busy || !list}
          onClick={() => {
            setSecret('');
            setNotice('');
            setError('');
            setOpen(true);
          }}
        >
          Generate Client Token
        </button>
      </div>
      <label className="http-endpoint-url">
        Local MCP URL
        <input readOnly value={endpoint} spellCheck={false} />
      </label>
      <p>
        Tokens grant MCP access, not access to Settings. Agent restrictions,
        tool policies and execution approvals still apply. A profile only
        narrows access. Revoke a token to close all of its sessions.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && !open && <p role="status">{notice}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setError('');
          void load().catch(() =>
            setError('Client tokens could not be loaded.'),
          );
        }}
      >
        Refresh tokens
      </button>
      {list?.tokens.length === 0 && (
        <p>
          No client tokens yet. Generate a separate token for each HTTP client.
        </p>
      )}
      {!!list?.tokens.length && (
        <ul className="profile-list http-token-list">
          {list.tokens.map((token) => (
            <li key={token.id}>
              <div className="row-main">
                <h3>{token.label}</h3>
                <code>{token.tokenPreview}</code>
                <p>
                  {token.agentId ?? 'http-client'} ·{' '}
                  {token.profileId
                    ? `Profile: ${profiles.find((profile) => profile.id === token.profileId)?.name ?? token.profileId}`
                    : 'All agent-permitted connectors'}
                </p>
                <p>
                  Created {new Date(token.createdAt).toLocaleString()}
                  {token.expiresAt
                    ? ` · Expires ${new Date(token.expiresAt).toLocaleString()}`
                    : ''}
                </p>
              </div>
              <span className="badge">
                {token.revokedAt
                  ? 'Revoked'
                  : token.expiresAt && Date.parse(token.expiresAt) <= Date.now()
                    ? 'Expired'
                    : 'Active'}
              </span>
              <button
                disabled={busy || !!token.revokedAt}
                aria-label={`Revoke token ${token.label}`}
                onClick={() => void revoke(token)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <dialog
          ref={dialog}
          className="http-token-dialog"
          aria-labelledby="http-token-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) dismiss();
          }}
          onClose={() => {
            if (!busy) dismiss();
          }}
        >
          <h2 id="http-token-dialog-title">
            {secret ? 'Copy your client token now' : 'Generate Client Token'}
          </h2>
          {secret ? (
            <>
              <p>
                This is the only time the full token is shown. It disappears
                when you close this dialog or after five minutes. The Hub stores
                only a hash and masked preview.
              </p>
              <label>
                One-time client token
                <textarea
                  aria-label="One-time client token"
                  readOnly
                  value={secret}
                  spellCheck={false}
                  autoComplete="off"
                  rows={3}
                />
              </label>
              <button onClick={() => void copy(secret, 'Token')}>
                Copy token
              </button>
              <label>
                HTTP client configuration
                <textarea
                  aria-label="HTTP client configuration"
                  readOnly
                  value={snippet}
                  spellCheck={false}
                  rows={11}
                />
              </label>
              <p>
                For Cursor or a custom client that supports URL + Bearer
                headers. Clients without native HTTP support need a separately
                configured adapter; this is not a stdio configuration.
              </p>
              <button onClick={() => void copy(snippet, 'Configuration')}>
                Copy config snippet
              </button>
            </>
          ) : (
            <form onSubmit={(event) => void generate(event)}>
              <label>
                Token label
                <input
                  name="label"
                  required
                  minLength={1}
                  maxLength={64}
                  autoComplete="off"
                  autoFocus
                  disabled={busy}
                />
              </label>
              <label>
                Agent identity
                <select
                  aria-label="Agent identity"
                  name="agentId"
                  defaultValue="http-client"
                  disabled={busy}
                >
                  <option value="http-client">HTTP client</option>
                  {IntegrationAgentIdSchema.options.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Profile restriction
                <select
                  aria-label="Profile restriction"
                  name="profileId"
                  disabled={busy}
                >
                  <option value="">All agent-permitted connectors</option>
                  {profiles
                    .filter((profile) => profile.enabled !== false)
                    .map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Expiration
                <select
                  aria-label="Expiration"
                  name="expiry"
                  defaultValue="never"
                  disabled={busy}
                >
                  <option value="never">Until revoked</option>
                  <option value="30d">30 days</option>
                </select>
              </label>
              <button className="primary" disabled={blocked || busy}>
                {busy ? 'Generating…' : 'Generate token'}
              </button>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <button disabled={busy} onClick={dismiss}>
            {secret ? 'Done — hide token' : 'Cancel'}
          </button>
        </dialog>
      )}
    </section>
  );
}
