import { useState } from 'react';
import type { AgentIntegration } from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';

export function AgentIntegrations({
  revision,
  blocked,
  refresh,
}: {
  revision: number;
  blocked: boolean;
  refresh: () => Promise<void>;
}) {
  const [agents, setAgents] = useState<AgentIntegration[]>([]),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  async function scan() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ agents: AgentIntegration[] }>(
        '/api/agents/scan',
        {},
      );
      setAgents(result.agents);
      setNotice(
        'Scan complete. Integration status describes configuration, not a live agent connection.',
      );
    } catch {
      setError(
        'Scan failed. Check local permissions and retry; no agent was started.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function change(agent: AgentIntegration) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{
        agent: AgentIntegration;
        backup: string | null;
      }>(
        `/api/agents/${agent.agentId}/${agent.status === 'integrated' ? 'disconnect' : 'integrate'}`,
        {
          expectedRevision: revision,
          fingerprint: agent.fingerprint,
          confirmConfigurationChange: true,
        },
      );
      setAgents((items) =>
        items.map((item) =>
          item.agentId === agent.agentId ? result.agent : item,
        ),
      );
      await refresh();
      setNotice(
        `${agent.name}: ${result.agent.status === 'integrated' ? 'configuration integrated' : 'hub entry disconnected'}. ${result.backup ? 'Private timestamped backup created. ' : ''}${agent.reconnect}`,
      );
    } catch {
      setError(
        'Change refused or incomplete. Rescan for conflicts, then inspect recovery before retrying. No unrelated entry is intentionally replaced.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="list-panel" aria-labelledby="integration-title">
      <div className="list-toolbar">
        <h2 id="integration-title">
          Windows agent integrations{' '}
          <span className="count">{agents.length}</span>
        </h2>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            void scan();
          }}
        >
          <Icon name="search" size={17} />
          {busy ? 'Working…' : 'Scan Installed Agents'}
        </button>
      </div>
      <div className="integration-guidance">
        <p>
          Scan known user configuration scopes without starting agents or a
          model turn. Integrate adds one managed hub launcher; Disconnect
          removes only that owned entry. Your pilot entries, plugins and
          policies stay in place.
        </p>
        <label className="import-check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I approve the listed user-file changes and private backups. Existing
          agents may require reconnect/approval.
        </label>
      </div>
      {notice && (
        <p className="notice integration-guidance" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-message integration-guidance" role="alert">
          {error}
        </p>
      )}
      {!agents.length ? (
        <div className="empty-state">
          <Icon name="agents" size={28} />
          <h3>Find your installed agents</h3>
          <p>
            No integration scan has run in this window. Configuration is never
            edited by scanning.
          </p>
        </div>
      ) : (
        <ul className="profile-list integration-list">
          {agents.map((agent) => (
            <li
              key={agent.agentId}
              data-testid={`integration-${agent.agentId}`}
            >
              <span className="row-icon" aria-hidden="true">
                <Icon name="agents" />
              </span>
              <div className="row-main">
                <h3>{agent.name}</h3>
                <p>
                  <code>{agent.configPath}</code>
                </p>
                <p>
                  {agent.executable ??
                    'Executable not found on the scanned PATH'}{' '}
                  · {agent.version ?? 'version unknown'}
                </p>
                <small>{agent.reconnect}</small>
              </div>
              <span className="badge">
                {agent.status === 'integrated'
                  ? 'Integrated'
                  : agent.status === 'not_integrated'
                    ? 'Not Integrated'
                    : 'Unknown'}{' '}
                · configuration only
              </span>
              <div className="row-actions">
                <button
                  disabled={
                    busy ||
                    blocked ||
                    !consent ||
                    agent.status === 'unknown' ||
                    !agent.detected
                  }
                  onClick={() => {
                    void change(agent);
                  }}
                >
                  {agent.status === 'integrated'
                    ? 'Disconnect'
                    : '1-Click Integrate'}
                </button>
              </div>
              {agent.reason !== 'none' && (
                <p className="notice">
                  {agent.reason.replaceAll('_', ' ')}. Resolve this scope before
                  applying; nothing is overwritten automatically.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="panel-footer">
        Integrated does not mean authenticated or live-verified.
        Project/account/plugin overrides and agent trust prompts remain
        agent-controlled.
      </div>
    </section>
  );
}
