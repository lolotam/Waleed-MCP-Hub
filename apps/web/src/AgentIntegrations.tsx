import { useEffect, useState } from 'react';
import type {
  AgentIntegration,
  ImportPreview,
  Profile,
  AgentToolSets,
  IntegrationAgentId,
} from '@waleed/contracts';
import { api } from './api.js';
import { Icon, agentPresentation } from './Icon.js';

export function AgentIntegrations({
  revision,
  blocked,
  refresh,
  importPreview,
  profiles,
  toolSets,
}: {
  revision: number;
  blocked: boolean;
  refresh: () => Promise<void>;
  importPreview?: (preview: ImportPreview) => void;
  profiles: Profile[];
  toolSets: AgentToolSets;
}) {
  const [agents, setAgents] = useState<AgentIntegration[]>([]),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [pendingProfiles, setPendingProfiles] = useState<
      Partial<Record<IntegrationAgentId, string>>
    >({}),
    [staleToolSets, setStaleToolSets] = useState(false);
  const [pendingSearchModes, setPendingSearchModes] = useState<
    Partial<Record<IntegrationAgentId, boolean>>
  >({});
  useEffect(() => {
    setPendingProfiles({});
    setPendingSearchModes({});
    setStaleToolSets(false);
  }, [toolSets]);
  async function changeSearchMode(
    agent: AgentIntegration,
    toolSearchMode: boolean,
  ) {
    setPendingSearchModes((items) => ({
      ...items,
      [agent.agentId]: toolSearchMode,
    }));
    setBusy(true);
    setError('');
    setNotice('Saving tool search mode…');
    let saved = false;
    try {
      const result = await api<{ state: string; recoveryRequired: boolean }>(
        `/api/agents/${agent.agentId}/tool-search`,
        { expectedRevision: toolSets.revision, toolSearchMode },
      );
      saved = true;
      await refresh();
      setNotice(
        result.recoveryRequired
          ? 'Tool search mode saved; recovery review is required.'
          : 'Tool search mode saved. Refresh the agent’s tool list to use the updated catalog. No agent configuration file was changed.',
      );
    } catch {
      if (!saved) setPendingSearchModes({});
      setStaleToolSets(true);
      setNotice('');
      setError(
        saved
          ? 'Tool search mode saved, but inventory refresh failed. Refresh tool sets before another change.'
          : 'Tool search mode was not confirmed. Refresh tool sets before retrying; another window may have changed inventory.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function assignProfile(agent: AgentIntegration, profileId: string) {
    setPendingProfiles((items) => ({ ...items, [agent.agentId]: profileId }));
    setBusy(true);
    setError('');
    setNotice('Saving agent tool set…');
    let saved = false;
    try {
      const result = await api<{ state: string; recoveryRequired: boolean }>(
        `/api/agents/${agent.agentId}/profile`,
        { expectedRevision: toolSets.revision, profileId: profileId || null },
      );
      saved = true;
      await refresh();
      setNotice(
        result.recoveryRequired
          ? 'Tool set saved; recovery review is required.'
          : 'Agent tool set saved. Managed bridges recheck each request and notify clients to refresh their tool lists. No agent configuration file was changed.',
      );
    } catch {
      if (!saved) setPendingProfiles({});
      setStaleToolSets(true);
      setNotice('');
      setError(
        saved
          ? 'Tool set saved, but inventory refresh failed. Refresh tool sets before changing another assignment.'
          : 'Tool set change was not confirmed. Refresh tool sets before retrying; another window may have changed inventory.',
      );
    } finally {
      setBusy(false);
    }
  }
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
      {staleToolSets && (
        <div className="integration-guidance">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void refresh()
                .then(() => {
                  setStaleToolSets(false);
                  setError('');
                  setPendingProfiles({});
                  setPendingSearchModes({});
                })
                .catch(() =>
                  setError(
                    'Tool set refresh failed. Retry after checking the local Hub.',
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            Refresh tool sets
          </button>
        </div>
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
          {agents.map((agent) => {
            const toolSet = toolSets.toolSets.find(
              (item) => item.agentId === agent.agentId,
            );
            return (
              <li
                key={agent.agentId}
                data-testid={`integration-${agent.agentId}`}
              >
                <span className="row-icon" aria-hidden="true">
                  <Icon name={agentPresentation[agent.agentId].icon} />
                </span>
                <div className="row-main">
                  <h3>{agent.name}</h3>
                  <div className="agent-identity-badges">
                    <span className="pill">
                      {agentPresentation[agent.agentId].kind}
                    </span>
                    <span className="pill">
                      {agent.detected ? 'Detected locally' : 'Not detected'}
                    </span>
                  </div>
                  <p>
                    <code>{agent.configPath}</code>
                  </p>
                  <p>
                    {agent.executable ??
                      'Executable not found on the scanned PATH'}{' '}
                    · {agent.version ?? 'version unknown'}
                  </p>
                  <small>{agent.reconnect}</small>
                  {(agent.status === 'integrated' ||
                    toolSet?.profileId ||
                    toolSet?.toolSearchMode) && (
                    <div className="agent-tool-set">
                      <label>
                        Profile / Tool Set for {agent.name}
                        <select
                          aria-label={`Profile / Tool Set for ${agent.name}`}
                          value={
                            pendingProfiles[agent.agentId] ??
                            toolSet?.profileId ??
                            ''
                          }
                          disabled={
                            busy || blocked || staleToolSets || !toolSet
                          }
                          onChange={(event) =>
                            void assignProfile(agent, event.target.value)
                          }
                        >
                          <option value="">All Connectors (Default)</option>
                          {profiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name}
                              {profile.enabled === false
                                ? ' (disabled — no connectors)'
                                : ''}
                            </option>
                          ))}
                          {toolSet?.profileId &&
                            !profiles.some(
                              (profile) => profile.id === toolSet.profileId,
                            ) && (
                              <option value={toolSet.profileId}>
                                Unavailable profile — access denied
                              </option>
                            )}
                        </select>
                      </label>
                      <label className="import-check agent-search-toggle">
                        <input
                          type="checkbox"
                          aria-label={`Tool Search Mode (search_tools + call_tool) for ${agent.name}`}
                          checked={
                            pendingSearchModes[agent.agentId] ??
                            toolSet?.toolSearchMode ??
                            false
                          }
                          disabled={
                            busy || blocked || staleToolSets || !toolSet
                          }
                          onChange={(event) =>
                            void changeSearchMode(agent, event.target.checked)
                          }
                        />
                        Tool Search Mode (search_tools + call_tool)
                      </label>
                      <span className="badge">
                        {(pendingSearchModes[agent.agentId] ??
                        toolSet?.toolSearchMode)
                          ? 'Tool search active · 2 meta-tools'
                          : 'Tool search off · full catalog'}
                      </span>
                      <small>
                        Search mode keeps schemas out of the initial catalog.
                        Searches discover approved tools on demand; calls still
                        enforce profile and per-tool permissions.
                      </small>
                      {toolSet && (
                        <span className="badge">
                          {toolSet.connectorCount} eligible connectors ·{' '}
                          {toolSet.toolCount} discovered tools (estimate)
                        </span>
                      )}
                      {toolSet?.unverifiedConnectorCount ? (
                        <small>
                          {toolSet.unverifiedConnectorCount} eligible connectors
                          have no current capability check. Counts are not live
                          agent verification.
                        </small>
                      ) : (
                        <small>
                          Counts use capability observations and exclude blocked
                          tools. No connector is contacted for these badges.
                        </small>
                      )}
                      {(toolSet?.profileState === 'disabled' ||
                        toolSet?.profileState === 'missing') && (
                        <small className="notice">
                          Assigned profile is {toolSet.profileState}; this agent
                          sees no connectors. Select another profile or
                          explicitly choose All Connectors.
                        </small>
                      )}
                    </div>
                  )}
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
                  {importPreview && (
                    <button
                      disabled={
                        busy ||
                        blocked ||
                        !agent.detected ||
                        agent.agentId === 'goose'
                      }
                      title={
                        agent.agentId === 'goose'
                          ? 'Goose YAML integration is supported; protected adoption of existing Goose extensions is not yet supported.'
                          : undefined
                      }
                      onClick={() => {
                        setBusy(true);
                        setError('');
                        void api<ImportPreview>(
                          `/api/adoption/agents/${agent.agentId}/preview`,
                          { expectedRevision: revision },
                        )
                          .then(importPreview)
                          .catch(() =>
                            setError(
                              'Agent import preview is unavailable, ambiguous, empty or invalid. No file was changed.',
                            ),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      Import agent configs
                    </button>
                  )}
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
                    {agent.reason.replaceAll('_', ' ')}. Resolve this scope
                    before applying; nothing is overwritten automatically.
                  </p>
                )}
              </li>
            );
          })}
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
