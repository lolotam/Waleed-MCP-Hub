import {
  useCallback,
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
} from 'react';
import {
  BootstrapSchema,
  OnboardingStatusSchema,
  type OnboardingStatus,
  type Bootstrap,
  type Profile,
  type AgentObservation,
  type HubState,
  type SecurityEvent,
  type DiscoveredAgent,
  type DiscoverySnapshot,
  type AdoptionPreview,
  type CapabilityObservation,
  type Materialization,
  type ImportPreview,
  type RegistryOption,
} from '@waleed/contracts';
import { api, sessionReady } from './api.js';
import { Icon } from './Icon.js';
import { ProfileDialog } from './ProfileDialog.js';
import { DiscoveryPanel } from './DiscoveryPanel.js';
import { ImportDialog } from './ImportDialog.js';
import {
  OperationDialog,
  type OperationDialogInput,
} from './OperationDialog.js';
import { ConnectorList, type ManagedConnector } from './ConnectorList.js';
import { AuthDialog } from './AuthDialog.js';
import { AgentIntegrations } from './AgentIntegrations.js';
import { ManualMcpDialog } from './ManualMcpDialog.js';
import { RegistryDialog } from './RegistryDialog.js';
import { Playground } from './Playground.js';
import { LifecycleSettings } from './LifecycleSettings.js';
import { CredentialStorageSettings } from './CredentialStorageSettings.js';
import { SetupSettings } from './SetupSettings.js';
const HttpEndpoints = lazy(() =>
  import('./HttpEndpoints.js').then((module) => ({
    default: module.HttpEndpoints,
  })),
);
import { OnboardingWizard } from './OnboardingWizard.js';
import { HelpBoundary } from './HelpBoundary.js';
const HelpDrawer = lazy(() =>
  import('./HelpDrawer.js').then((module) => ({ default: module.HelpDrawer })),
);
import { shouldShowOnboarding, type OnboardingStep } from './onboarding.js';

const pages = [
  'Connectors',
  'Agents',
  'Profiles',
  'Activity',
  'Playground & Logs',
  'Settings',
] as const;
type Page = (typeof pages)[number];
const iconNames = [
  'connectors',
  'agents',
  'profiles',
  'activity',
  'playground',
  'settings',
] as const;
const descriptions: Record<Page, string> = {
  Connectors: 'One place for your tools. Explicit control over where they run.',
  Agents: 'Installed, configured, and verified are three different things.',
  Profiles: 'Organize tools around the way you work.',
  Activity: 'A local record of changes. No credentials or raw payloads.',
  'Playground & Logs':
    'Review a schema. Confirm one call. Keep only safe request metadata.',
  Settings: 'Your machine. Your configuration. Nothing enabled silently.',
};
const agentNames: Record<string, string> = {
  opencode: 'OpenCode',
  codex: 'Codex',
  antigravity: 'Antigravity',
  grok: 'Grok',
  claude: 'Claude Code',
  kilo: 'Kilo Code',
  kimi: 'Kimi Code',
  cursor: 'Cursor Agent',
};

export function App() {
  const [page, setPage] = useState<Page>('Connectors');
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [agentToolSets, setAgentToolSets] = useState<
    import('@waleed/contracts').AgentToolSets
  >({ revision: 0, toolSets: [] });
  const [connectors, setConnectors] = useState<ManagedConnector[]>([]);
  const [observations, setObservations] = useState<CapabilityObservation[]>([]);
  const [materializations, setMaterializations] = useState<
    Array<Materialization & { stale: boolean }>
  >([]);
  const [operation, setOperation] = useState<OperationDialogInput | null>(null);
  const [authentication, setAuthentication] = useState<ManagedConnector | null>(
    null,
  );
  const [agents, setAgents] = useState<
    Array<AgentObservation & Partial<DiscoveredAgent>>
  >([]);
  const [discovery, setDiscovery] = useState<DiscoverySnapshot | null>(null);
  const [adoption, setAdoption] = useState<AdoptionPreview | null>(null);
  const [activity, setActivity] = useState<HubState['activity']>([]);
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([]);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [manual, setManual] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pastedImport, setPastedImport] = useState<ImportPreview | null>(null);
  const [agentImport, setAgentImport] = useState<ImportPreview | null>(null),
    [browsingRegistry, setBrowsingRegistry] = useState(false),
    [registrySuggestion, setRegistrySuggestion] = useState<
      RegistryOption | undefined
    >();
  const [search, setSearch] = useState('');
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null),
    [tourStep, setTourStep] = useState<OnboardingStep>(0),
    [tourBusy, setTourBusy] = useState(false),
    [tourError, setTourError] = useState(''),
    [tourNotice, setTourNotice] = useState(''),
    [helpOpen, setHelpOpen] = useState(false),
    [manualInitialType, setManualInitialType] = useState<'stdio' | 'npx'>(
      'stdio',
    );
  const tourPending = useRef(false);
  async function saveOnboarding(completed: boolean) {
    if (!onboarding || tourPending.current || recoveryBlocked) return;
    tourPending.current = true;
    setTourBusy(true);
    setTourError('');
    setTourNotice('');
    try {
      const result = OnboardingStatusSchema.parse(
        await api('/api/settings/onboarding', {
          expectedRevision: onboarding.revision,
          onboardingCompleted: completed,
        }),
      );
      setOnboarding((current) =>
        !current || result.revision >= current.revision ? result : current,
      );
      if (!completed) {
        setTourStep(0);
        setPage('Connectors');
        setSearch('');
      } else {
        setTourNotice(
          'Tour dismissed. Re-run Onboarding is available in Settings.',
        );
        document.getElementById('main')?.focus();
      }
    } catch {
      setTourError(
        'Onboarding preference was not confirmed. Refresh status before retrying; another window may have changed settings.',
      );
      try {
        const status = OnboardingStatusSchema.parse(
          await api('/api/settings/onboarding'),
        );
        setOnboarding((current) =>
          !current || status.revision >= current.revision ? status : current,
        );
      } catch {
        /* Do not pretend a failed save completed the tour. */
      }
    } finally {
      tourPending.current = false;
      setTourBusy(false);
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await sessionReady;
      const [
        info,
        profileResult,
        agentResult,
        events,
        security,
        recovery,
        connectorResult,
        toolSetResult,
        onboardingResult,
      ] = await Promise.all([
        api('/api/bootstrap'),
        api<{
          profiles: Profile[];
          revision: number;
          materializations: Array<Materialization & { stale: boolean }>;
        }>('/api/profiles'),
        api<{ agents: Array<AgentObservation & Partial<DiscoveredAgent>> }>(
          '/api/agents',
        ),
        api<{ events: HubState['activity'] }>('/api/activity'),
        api<{ events: SecurityEvent[] }>('/api/security-activity'),
        api<{ blocked: boolean }>('/api/recovery'),
        api<{
          connectors: ManagedConnector[];
          observations: CapabilityObservation[];
        }>('/api/connectors'),
        api<import('@waleed/contracts').AgentToolSets>('/api/agents/tool-sets'),
        api('/api/settings/onboarding'),
      ]);
      setBootstrap({
        ...BootstrapSchema.parse(info),
        revision: profileResult.revision,
      });
      setProfiles(profileResult.profiles);
      setAgentToolSets(toolSetResult);
      const status = OnboardingStatusSchema.parse(onboardingResult);
      setOnboarding((current) =>
        !current || status.revision >= current.revision ? status : current,
      );
      setConnectors(connectorResult.connectors);
      setObservations(connectorResult.observations);
      setMaterializations(profileResult.materializations);
      setAgents(agentResult.agents);
      setActivity(events.events);
      setSecurityEvents(security.events);
      setRecoveryBlocked(recovery.blocked);
      if (BootstrapSchema.parse(info).capabilities.discovery) {
        const [snapshot, preview] = await Promise.all([
          api<DiscoverySnapshot>('/api/discovery'),
          api<AdoptionPreview>('/api/adoption/preview'),
        ]);
        setDiscovery(snapshot);
        setAdoption(preview);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'The hub is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredProfiles = profiles.filter((profile) =>
    `${profile.name} ${profile.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="connectors" size={22} />
          </span>
          <div>
            Waleed MCP Hub<span className="brand-caption">Local workspace</span>
          </div>
        </div>
        <div className="workspace-label">MANAGE</div>
        <nav aria-label="Main navigation">
          {pages.map((item, index) => (
            <button
              key={item}
              className={page === item ? 'nav-item selected' : 'nav-item'}
              aria-current={page === item ? 'page' : undefined}
              onClick={() => {
                setPage(item);
                setSearch('');
              }}
            >
              <Icon name={iconNames[index]!} />
              <span>{item}</span>
              {item === 'Profiles' && profiles.length > 0 && (
                <span className="nav-count">{profiles.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-indicator">
            <Icon name="shield" size={17} />
            <strong>Loopback only</strong>
          </div>
          <p>127.0.0.1 · Same-user session</p>
          <div className="dependency">
            <span className="status-dot" />
            Docker{' '}
            <span>
              {discovery?.docker.state.replaceAll('_', ' ') ?? 'Not checked'}
            </span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Personal workspace <span className="slash">/</span>{' '}
            <strong>{page}</strong>
          </span>
          <div className="topbar-actions">
            <button type="button" onClick={() => setHelpOpen(true)}>
              <Icon name="help" size={18} />
              Help & Guides
            </button>
            <span className="stage-label">
              {bootstrap?.capabilities.connectorManagement
                ? 'Lifecycle build'
                : 'Foundation build'}{' '}
              <span className="version">v0.1</span>
            </span>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">MCP CONTROL PANEL</div>
              <h1>{page}</h1>
              <p>{descriptions[page]}</p>
            </div>
            {page === 'Profiles' ? (
              <button
                className="primary"
                disabled={loading || !!error || recoveryBlocked}
                onClick={() => setCreating(true)}
              >
                <Icon name="plus" size={18} />
                Create profile
              </button>
            ) : page === 'Connectors' ? (
              <div className="action-with-help">
                <button
                  disabled={loading || !!error || recoveryBlocked}
                  onClick={() => {
                    setRegistrySuggestion(undefined);
                    setManualInitialType('stdio');
                    setManual(true);
                  }}
                >
                  Add Manual MCP
                </button>
                <button
                  disabled={loading || !!error || recoveryBlocked}
                  onClick={() => setBrowsingRegistry(true)}
                >
                  Browse MCP Registry
                </button>
                <button
                  className="primary"
                  disabled={loading || !!error}
                  onClick={() => setImporting(true)}
                  aria-describedby="add-help"
                >
                  <Icon name="plus" size={18} />
                  Add connector
                </button>
                <small id="add-help">
                  Preview first · saving and execution are separate
                </small>
              </div>
            ) : (
              <button
                disabled={loading}
                onClick={() => {
                  void refresh();
                }}
              >
                <Icon name="clock" size={16} />
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </div>

          <div className="foundation-notice">
            <Icon name="shield" />
            <div>
              <strong>A safe starting point.</strong>{' '}
              {bootstrap?.capabilities.discovery
                ? 'Discovery does not execute connectors. Agent-config imports require a separate reviewed apply; exact execution approval and capability checks remain separate. Legacy pilot adoption stays disabled.'
                : bootstrap?.capabilities.agentApply
                  ? 'Save definitions locally, approve exact execution separately, and manage protected credentials explicitly. Agent integration verifies configuration only; reconnect and trust remain agent-controlled.'
                  : 'Save definitions locally, approve exact execution separately, and manage protected credentials explicitly. Capability tests use available runtime adapters; agent synchronization remains disabled.'}
            </div>
            <span className="read-only-tag">Explicit actions only</span>
          </div>
          {bootstrap &&
            !error &&
            page === 'Connectors' &&
            shouldShowOnboarding(onboarding?.onboardingCompleted) && (
              <OnboardingWizard
                step={tourStep}
                setStep={setTourStep}
                busy={tourBusy}
                blocked={recoveryBlocked}
                notice={tourNotice}
                error={tourError}
                complete={() => void saveOnboarding(true)}
                connectAgents={
                  bootstrap.capabilities.agentApply ? (
                    <AgentIntegrations
                      revision={bootstrap.revision}
                      blocked={recoveryBlocked}
                      refresh={refresh}
                      profiles={profiles}
                      toolSets={agentToolSets}
                    />
                  ) : (
                    <p className="notice">
                      Agent configuration integration is unavailable in this
                      runtime. You can still read the connecting-agents guide in
                      Help and continue the tour.
                    </p>
                  )
                }
                add={(kind) => {
                  setRegistrySuggestion(undefined);
                  if (kind === 'registry') setBrowsingRegistry(true);
                  else {
                    setManualInitialType(kind === 'package' ? 'npx' : 'stdio');
                    setManual(true);
                  }
                }}
                go={(target) => {
                  setPage(
                    target === 'playground'
                      ? 'Playground & Logs'
                      : 'Connectors',
                  );
                  if (target === 'tools')
                    document
                      .getElementById('connector-workspace')
                      ?.scrollIntoView({ block: 'start' });
                }}
                help={() => setHelpOpen(true)}
              />
            )}
          {page !== 'Settings' &&
            onboarding?.onboardingCompleted &&
            tourNotice && <p role="status">{tourNotice}</p>}
          {page !== 'Settings' &&
            onboarding?.onboardingCompleted &&
            tourError && <p role="alert">{tourError}</p>}
          {error ? (
            <section className="error-panel" role="alert">
              <h2>Unable to load this workspace</h2>
              <p>{error}</p>
              <button
                onClick={() => {
                  void refresh();
                }}
              >
                Retry
              </button>
            </section>
          ) : loading && !bootstrap ? (
            <div className="loading-state" role="status">
              Opening your local workspace…
            </div>
          ) : (
            <>
              {bootstrap?.capabilities.discovery && (
                <DiscoveryPanel
                  snapshot={discovery}
                  preview={adoption}
                  refresh={refresh}
                />
              )}
              {recoveryBlocked && (
                <section className="error-panel" role="alert">
                  <h2>Recovery review required</h2>
                  <p>
                    An unfinished operation needs recovery review. Further
                    changes are blocked; nothing will be replayed or rolled back
                    automatically. Inspect the local runtime using the README
                    recovery instructions before retrying.
                  </p>
                  <a href="/api/recovery" target="_blank" rel="noreferrer">
                    Inspect recovery metadata
                  </a>
                </section>
              )}
              {page === 'Connectors' && (
                <section
                  className="list-panel"
                  aria-labelledby="connector-list-title"
                  id="connector-workspace"
                >
                  <div className="list-toolbar">
                    <h2 id="connector-list-title">
                      Your connectors{' '}
                      <span className="count">{connectors.length}</span>
                    </h2>
                    <span className="muted">
                      Desired state · not a live verification
                    </span>
                  </div>
                  <div className="panel-footer">
                    Definitions, verification and desired profile membership
                  </div>
                  {connectors.length ? (
                    <ConnectorList
                      revision={bootstrap?.revision ?? 0}
                      connectors={connectors}
                      observations={observations}
                      profiles={profiles}
                      disabled={recoveryBlocked}
                      runtime={!!bootstrap?.capabilities.runtimeChecks}
                      secrets={!!bootstrap?.capabilities.secrets}
                      authenticate={setAuthentication}
                      operate={setOperation}
                      refresh={refresh}
                    />
                  ) : (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <Icon name="connectors" size={28} />
                      </div>
                      <h2>Your existing tools stay where they are</h2>
                      <p>
                        {discovery?.checkedAt
                          ? 'Read-only observations are available in the adoption preview above. No connector definition has been imported into the registry or executed.'
                          : 'The hub has not inspected or imported your pilot yet. Use read-only discovery to review your existing setup; adoption remains a separate explicit step.'}
                      </p>
                      <button onClick={() => setPage('Profiles')}>
                        Set up a local profile <Icon name="arrow" size={16} />
                      </button>
                      <small>
                        Creating a profile does not register tools with agents.
                      </small>
                    </div>
                  )}
                  <div className="panel-footer">
                    <Icon name="lock" size={15} />
                    Saving is not execution. Capability discovery calls no
                    tools.
                  </div>
                </section>
              )}
              {page === 'Profiles' && (
                <section className="list-panel">
                  <div className="list-toolbar">
                    <h2>
                      Local profiles{' '}
                      <span className="count">{profiles.length}</span>
                    </h2>
                    <label className="search">
                      <Icon name="search" size={17} />
                      <span className="sr-only">Search profiles</span>
                      <input
                        type="search"
                        placeholder="Search profiles…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                  </div>
                  {profiles.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <Icon name="profiles" size={28} />
                      </div>
                      <h2>A place for each workflow</h2>
                      <p>
                        Create a profile, edit its connector membership, then
                        explicitly preview and apply its owned runtime files.
                      </p>
                      <button
                        disabled={recoveryBlocked}
                        onClick={() => setCreating(true)}
                      >
                        <Icon name="plus" size={17} />
                        Create your first profile
                      </button>
                    </div>
                  ) : filteredProfiles.length === 0 ? (
                    <div className="empty-state">
                      <h2>No matching profiles</h2>
                      <p>Try a different name or description.</p>
                    </div>
                  ) : (
                    <ul className="profile-list">
                      {filteredProfiles.map((profile) => (
                        <li key={profile.id}>
                          <span className="row-icon">
                            <Icon name="profiles" />
                          </span>
                          <div className="row-main">
                            <h3>{profile.name}</h3>
                            <p>{profile.description || 'No description'}</p>
                          </div>
                          <span className="badge">
                            {materializations.some(
                              (record) =>
                                record.profileId === profile.id && record.stale,
                            )
                              ? 'Snapshot stale — apply again'
                              : profile.enabled === false
                                ? 'Disabled'
                                : materializations.some(
                                      (record) =>
                                        record.profileId === profile.id,
                                    )
                                  ? 'Snapshot applied — reconnect may be needed'
                                  : 'Local only'}
                          </span>
                          <span className="muted">
                            {profile.connectorIds.length} connectors
                          </span>
                          <div
                            className="row-actions"
                            role="group"
                            aria-label={`Actions for profile ${profile.name}`}
                          >
                            <button
                              disabled={recoveryBlocked}
                              onClick={() =>
                                setOperation({
                                  title: 'Edit profile membership',
                                  operation: {
                                    kind: 'edit_profile',
                                    profileId: profile.id,
                                  },
                                  editor: 'profile',
                                  context: {
                                    name: profile.name,
                                    description: profile.description,
                                    connectorIds: profile.connectorIds,
                                    enabled: profile.enabled !== false,
                                  },
                                })
                              }
                            >
                              Edit membership
                            </button>
                            <button
                              disabled={recoveryBlocked}
                              onClick={() =>
                                setOperation({
                                  title:
                                    profile.enabled === false
                                      ? 'Enable profile'
                                      : 'Disable profile',
                                  operation: {
                                    kind: 'set_profile_enabled',
                                    profileId: profile.id,
                                    enabled: profile.enabled === false,
                                  },
                                  context: {
                                    effect:
                                      'Desired state only; apply the profile and reconnect existing clients.',
                                  },
                                })
                              }
                            >
                              {profile.enabled === false
                                ? 'Enable profile'
                                : 'Disable profile'}
                            </button>
                            <button
                              disabled={
                                recoveryBlocked ||
                                !bootstrap?.capabilities.materialization
                              }
                              onClick={() =>
                                setOperation({
                                  title: 'Apply owned profile snapshot',
                                  operation: {
                                    kind: 'materialize_profile',
                                    profileId: profile.id,
                                  },
                                  context: {
                                    connectorIds: profile.connectorIds,
                                    effect:
                                      'Writes generated catalogs/launchers and isolated Docker profile only; never starts a connector or edits agent settings.',
                                  },
                                })
                              }
                            >
                              Apply profile
                            </button>
                            <button
                              disabled={
                                recoveryBlocked ||
                                !materializations.some(
                                  (record) => record.profileId === profile.id,
                                )
                              }
                              onClick={() =>
                                setOperation({
                                  title: 'Remove owned materialization',
                                  operation: {
                                    kind: 'dematerialize_profile',
                                    profileId: profile.id,
                                  },
                                })
                              }
                            >
                              Dematerialize
                            </button>
                            <button
                              disabled={
                                recoveryBlocked ||
                                materializations.some(
                                  (record) => record.profileId === profile.id,
                                )
                              }
                              onClick={() =>
                                setOperation({
                                  title: 'Remove local profile',
                                  operation: {
                                    kind: 'remove_profile',
                                    profileId: profile.id,
                                  },
                                  context: {
                                    effect:
                                      'Removes profile definition, not its connector definitions or credentials.',
                                  },
                                })
                              }
                            >
                              Remove profile
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="panel-footer">
                    Registry revision {bootstrap?.revision} · Changes require a
                    preview before apply
                  </div>
                </section>
              )}
              {page === 'Agents' && bootstrap?.capabilities.agentApply && (
                <AgentIntegrations
                  profiles={profiles}
                  toolSets={agentToolSets}
                  importPreview={(preview) => {
                    setAgentImport(preview);
                    setImporting(true);
                  }}
                  revision={bootstrap.revision}
                  blocked={recoveryBlocked}
                  refresh={refresh}
                />
              )}
              {page === 'Playground & Logs' && bootstrap && (
                <Playground
                  connectors={connectors}
                  revision={bootstrap.revision}
                  enabled={!!bootstrap.capabilities.playground}
                  blocked={recoveryBlocked}
                />
              )}
              {page === 'Agents' && !bootstrap?.capabilities.agentApply && (
                <section className="list-panel">
                  <div className="list-toolbar">
                    <h2>
                      Integration targets <span className="count">8</span>
                    </h2>
                    <span className="muted">
                      {discovery?.checkedAt
                        ? 'User-file observations · not live MCP verification'
                        : 'Not an installed inventory'}
                    </span>
                  </div>
                  <ul className="agent-list">
                    {agents.map((agent) => (
                      <li key={agent.agentId}>
                        <span className="agent-initials">
                          {agentNames[agent.agentId]?.slice(0, 2)}
                        </span>
                        <div className="row-main">
                          <h3>{agentNames[agent.agentId]}</h3>
                          {agent.checkedAt ? (
                            <>
                              <p>
                                {agent.detected === true
                                  ? 'Executable found'
                                  : agent.detected === false
                                    ? 'Executable not found'
                                    : 'Executable discovery error'}{' '}
                                ·{' '}
                                {agent.version
                                  ? `${agent.version} (${agent.versionSource ?? 'observed'})`
                                  : 'version unknown'}{' '}
                                · user bindings:{' '}
                                {agent.configSummary ?? 'pending'}
                              </p>
                              <p>
                                {agent.executable ??
                                  'No resolved executable path'}
                              </p>
                              {agent.configFiles &&
                              agent.configFiles.length > 0 ? (
                                <details>
                                  <summary>Observed user configuration</summary>
                                  <ul>
                                    {agent.configFiles.map((file) => (
                                      <li key={file.path}>
                                        {file.path} · {file.status} ·{' '}
                                        {file.entryCount === null
                                          ? 'entries unknown'
                                          : `${file.entryCount} entries`}{' '}
                                        · hub pointers:{' '}
                                        {file.hubEntries.join(', ') ||
                                          'none observed'}
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              ) : (
                                <p>
                                  Version-specific configuration scope is
                                  pending; no schema was guessed.
                                </p>
                              )}
                            </>
                          ) : (
                            <p>
                              Executable, version, and configuration have not
                              been inspected.
                            </p>
                          )}
                        </div>
                        <span className="badge">
                          <Icon name="clock" size={14} />
                          Adapter pending
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="panel-footer">
                    {discovery?.checkedAt
                      ? 'Selected user configuration files were read only. Credential caches were not read; token values are excluded from discovery output. No MCP discovery was performed.'
                      : 'No CLI configuration files have been opened or modified.'}
                  </div>
                </section>
              )}
              {page === 'Activity' && (
                <>
                  <section className="list-panel">
                    <div className="list-toolbar">
                      <h2>Registry activity</h2>
                      <span className="muted">
                        Last 200 successful local changes
                      </span>
                    </div>
                    {activity.length === 0 ? (
                      <div className="empty-state">
                        <Icon name="activity" size={28} />
                        <h2>No registry changes yet</h2>
                        <p>
                          Successful local profile changes will appear here.
                          Refused requests are recorded separately below; no
                          request payloads are stored.
                        </p>
                      </div>
                    ) : (
                      <ul className="activity-list">
                        {[...activity].reverse().map((event) => (
                          <li key={event.id}>
                            <Icon name="check" size={18} />
                            <div className="row-main">
                              <h3>{event.operation.replaceAll('_', ' ')}</h3>
                              <p>
                                Registry revision {event.priorRevision} →{' '}
                                {event.newRevision}
                              </p>
                            </div>
                            <time dateTime={event.time}>
                              {new Date(event.time).toLocaleString()}
                            </time>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section
                    className="list-panel safety-section"
                    aria-labelledby="security-activity-title"
                  >
                    <div className="list-toolbar">
                      <h2 id="security-activity-title">Security refusals</h2>
                      <span className="muted">Latest 200 · metadata only</span>
                    </div>
                    {securityEvents.length === 0 ? (
                      <div className="empty-state">
                        <Icon name="shield" size={28} />
                        <h2>No refused requests recorded</h2>
                        <p>
                          Denied origins, missing sessions, invalid inputs, and
                          conflicts appear here without headers, credentials, or
                          request bodies.
                        </p>
                      </div>
                    ) : (
                      <ul className="activity-list">
                        {[...securityEvents].reverse().map((event) => (
                          <li key={event.id}>
                            <Icon name="shield" size={18} />
                            <div className="row-main">
                              <h3>{event.reason.replaceAll('_', ' ')}</h3>
                              <p>
                                {event.method} ·{' '}
                                {event.route.replaceAll('_', ' ')} · HTTP{' '}
                                {event.status}
                              </p>
                            </div>
                            <time dateTime={event.time}>
                              {new Date(event.time).toLocaleString()}
                            </time>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )}
              {page === 'Settings' && bootstrap?.capabilities.desktop && (
                <section className="list-panel integration-guidance">
                  <h2>Windows desktop session</h2>
                  <p>
                    By default, closing the app window leaves the same-user
                    manager running. Use this action to release its locks and
                    shut down gracefully; independent agent bridges remain
                    agent-owned.
                  </p>
                  <button
                    onClick={() => {
                      void api('/api/desktop/shutdown', {})
                        .then(() =>
                          setError(
                            'Desktop manager stopped. You can close this window.',
                          ),
                        )
                        .catch(() =>
                          setError('Shutdown could not be confirmed.'),
                        );
                    }}
                  >
                    Stop desktop manager
                  </button>
                </section>
              )}
              {page === 'Settings' && (
                <section className="list-panel integration-guidance">
                  <h2>Onboarding & help</h2>
                  <p>
                    Finished or skipped tours stay dismissed, even when no
                    connectors are configured. Re-run only when you choose.
                  </p>
                  <button
                    disabled={tourBusy || recoveryBlocked || !onboarding}
                    onClick={() => void saveOnboarding(false)}
                  >
                    Re-run Onboarding
                  </button>
                  {tourNotice && <p role="status">{tourNotice}</p>}
                  {tourError && <p role="alert">{tourError}</p>}
                </section>
              )}
              {page === 'Settings' && (
                <LifecycleSettings
                  blocked={recoveryBlocked}
                  desktop={!!bootstrap?.capabilities.desktop}
                />
              )}
              {page === 'Settings' && <CredentialStorageSettings />}
              {page === 'Settings' && (
                <SetupSettings
                  blocked={recoveryBlocked}
                  revision={bootstrap?.revision ?? 0}
                  refresh={refresh}
                />
              )}
              {page === 'Settings' && (
                <Suspense fallback={<p>Loading HTTP endpoint settings…</p>}>
                  <HttpEndpoints
                    profiles={profiles}
                    blocked={recoveryBlocked}
                  />
                </Suspense>
              )}
              {page === 'Settings' && (
                <section className="list-panel settings">
                  <div className="list-toolbar">
                    <h2>Runtime & safeguards</h2>
                  </div>
                  <dl>
                    <div>
                      <dt>Local server</dt>
                      <dd>{window.location.origin}</dd>
                    </div>
                    <div>
                      <dt>Node.js</dt>
                      <dd>{bootstrap?.runtime.node}</dd>
                    </div>
                    <div>
                      <dt>State storage</dt>
                      <dd>Versioned JSON · atomic replacement · 5 backups</dd>
                    </div>
                    <div>
                      <dt>Recovery journal</dt>
                      <dd>
                        {recoveryBlocked
                          ? 'Review required · changes blocked'
                          : 'No unresolved operations'}{' '}
                        · external uncertainty blocks for review
                      </dd>
                    </div>
                    <div>
                      <dt>Refusal audit</dt>
                      <dd>
                        Persisted locally · latest 200 · no request payloads
                      </dd>
                    </div>
                    <div>
                      <dt>Authentication</dt>
                      <dd>
                        One-time launch · HttpOnly session · CSRF protection
                      </dd>
                    </div>
                    <div>
                      <dt>Docker discovery</dt>
                      <dd>
                        {discovery?.checkedAt
                          ? `${discovery.docker.state} · CLI ${discovery.docker.cliVersion ?? 'unknown'} · gateway ${discovery.docker.gatewayVersion ?? 'unknown'} · engine ${discovery.docker.engineVersion ?? 'unknown'} · ${discovery.docker.reason.replaceAll('_', ' ')}`
                          : 'Not scanned · only explicit read-only discovery runs Docker queries'}
                      </dd>
                    </div>
                    <div>
                      <dt>Secret storage & OAuth</dt>
                      <dd>
                        {bootstrap?.capabilities.secrets
                          ? 'Write-only protected credentials · supported OAuth recipes only · discovery required for verification'
                          : 'Protected credential backend unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt>Windows sign-in startup</dt>
                      <dd>
                        Opt-in current-user launcher registration · live status
                        above
                      </dd>
                    </div>
                  </dl>
                </section>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span>
              <Icon name="shield" size={14} />
              Local-first. Review before change.
            </span>
            <span>
              {bootstrap?.capabilities.connectorManagement
                ? 'Protected credentials · configuration-only agent integration'
                : 'P1 foundation / P2 in progress'}
            </span>
          </footer>
        </main>
      </div>
      {creating && bootstrap && (
        <ProfileDialog
          revision={bootstrap.revision}
          close={() => setCreating(false)}
          saved={refresh}
        />
      )}
      {importing && bootstrap && (
        <ImportDialog
          revision={bootstrap.revision}
          initialPreview={agentImport ?? pastedImport ?? undefined}
          agentSource={!!agentImport}
          profiles={profiles}
          close={() => {
            setImporting(false);
            setAgentImport(null);
            setPastedImport(null);
          }}
          refresh={refresh}
          savePreview={(preview, definitions) => {
            setImporting(false);
            setAgentImport(null);
            setPastedImport(null);
            setOperation({
              title: 'Save connector definitions locally',
              operation: { kind: 'create_connectors', definitions },
              context: definitions,
              initialPreview: preview,
            });
          }}
        />
      )}
      {operation && bootstrap && (
        <OperationDialog
          input={operation}
          revision={bootstrap.revision}
          close={() => setOperation(null)}
          refresh={refresh}
        />
      )}
      {browsingRegistry && (
        <RegistryDialog
          close={() => setBrowsingRegistry(false)}
          select={(option) => {
            setRegistrySuggestion(option);
            setBrowsingRegistry(false);
            setManual(true);
          }}
        />
      )}
      {authentication && bootstrap && (
        <AuthDialog
          connector={authentication}
          revision={bootstrap.revision}
          close={() => setAuthentication(null)}
          refresh={refresh}
        />
      )}
      {manual && bootstrap && (
        <ManualMcpDialog
          initialType={manualInitialType}
          importJson={async (source) => {
            const preview = await api<ImportPreview>('/api/imports/preview', {
              expectedRevision: bootstrap.revision,
              source,
            });
            setPastedImport(preview);
            setAgentImport(null);
            setManual(false);
            setImporting(true);
          }}
          suggestion={registrySuggestion}
          revision={bootstrap.revision}
          close={() => setManual(false)}
          refresh={refresh}
        />
      )}
      {helpOpen && (
        <HelpBoundary close={() => setHelpOpen(false)}>
          <Suspense
            fallback={
              <p className="help-load-error" role="status">
                Opening local guides…
              </p>
            }
          >
            <HelpDrawer close={() => setHelpOpen(false)} />
          </Suspense>
        </HelpBoundary>
      )}
    </div>
  );
}
