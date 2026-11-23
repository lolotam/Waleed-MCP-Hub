import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  BootstrapSchema,
  type Bootstrap,
  type Profile,
  type AgentObservation,
  type HubState,
  type SecurityEvent,
  type DiscoveredAgent,
  type DiscoverySnapshot,
  type AdoptionPreview,
  type CapabilityObservation,
  type ConnectorExport,
  type Materialization,
  type PackageProposal,
} from '@waleed/contracts';
import { api, ApiError, sessionReady } from './api.js';
import { latestRunner, untilAborted } from './latest.js';
import { Icon } from './Icon.js';
import {
  entries,
  entryOf,
  firstPlace,
  formatPlace,
  parsePlace,
  resolvePlace,
  samePlace,
  visiblePills,
  visibleTabs,
  type Place,
} from './navigation.js';
import { PillRow, TabPanel, TabRow } from './Tabs.js';
import { ProfileDialog } from './ProfileDialog.js';
import { DiscoveryPanel } from './DiscoveryPanel.js';
import { AgentCloning } from './AgentCloning.js';
import { UpdateNotice, useUpdateCheck } from './UpdateNotice.js';
import { ActivityPage } from './ActivityPage.js';
import {
  AppearancePanel,
  RecoveryStatus,
  RuntimeSettings,
} from './SettingsPage.js';
import { ImportDialog } from './ImportDialog.js';
import {
  OperationDialog,
  type OperationDialogInput,
} from './OperationDialog.js';
import {
  ConnectorList,
  connectorTarget,
  type ManagedConnector,
} from './ConnectorList.js';
import { DiscoveryProgress } from './DiscoveryProgress.js';
import { currentObservation, isApproved } from './discovery-progress.js';
import { AuthDialog } from './AuthDialog.js';
import { AgentIntegrations } from './AgentIntegrations.js';
import { ManualMcpPage } from './ManualMcpDialog.js';
import { PackageDialog, type PackageSeed } from './PackageInstall.js';
import { readTheme, setTheme, type ThemeChoice } from './theme.js';

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

// The status filter of the connector list. The filter is a set of toggles, not
// a radio group: a page radio would be counted by the package browser test.
const connectorFilters = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'loading', label: 'Loading' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'disabled', label: 'Disabled' },
] as const;
type ConnectorFilter = (typeof connectorFilters)[number]['id'];
// The status a connector shows in the list, and the filter it belongs to.
type ConnectorStatus = Exclude<ConnectorFilter, 'all'>;

// The status of one connector: a disabled connector is disabled, an enabled
// connector without a valid approval needs attention, a connected connector is
// ready, and one whose discovery has not settled yet is loading.
function connectorStatus(
  connector: ManagedConnector,
  observations: CapabilityObservation[],
): ConnectorStatus {
  if (!connector.enabled) return 'disabled';
  if (!isApproved(connector)) return 'attention';
  const state =
    currentObservation(connector, observations)?.state ?? 'untested';
  if (state === 'connected') return 'ready';
  if (state === 'untested' || state === 'checking') return 'loading';
  return 'attention';
}

// The search of the list reads the name, the identifier and the target of a
// connector.
function connectorMatches(
  connector: ManagedConnector,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return `${connector.name} ${connector.id} ${connectorTarget(connector)}`
    .toLowerCase()
    .includes(needle);
}

// The longest wait on one full refresh of the hub state.
const REFRESH_LIMIT_MS = 20_000;

// One exported part becomes one file in the browser. The hub names the parts
// after the day and the part number, so a registry of many connectors lands
// in several files.
function exportFileName(part: number, parts: number, stamp: string): string {
  return parts === 1
    ? `waleed-mcp-hub-connectors-${stamp}.json`
    : `waleed-mcp-hub-connectors-${stamp}-part-${part}-of-${parts}.json`;
}

function downloadPart(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // The download reads the object URL after the click returns.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

// The address of a place on this page, for a history entry.
const address = (target: Place) =>
  window.location.pathname + window.location.search + formatPlace(target);

// The position of a history entry, as this app wrote it into the entry.
function positionOf(state: unknown): number | null {
  const position = (state as { position?: unknown } | null)?.position;
  return typeof position === 'number' ? position : null;
}

// A private import draft lives five minutes on the hub.
const DRAFT_LIFETIME_MS = 5 * 60_000;

// The place of one pill under Add.
const addPlace = (pill: string): Place => ({
  entry: 'connectors',
  tab: 'add',
  pill,
});

export function App() {
  // The place is held in the address, so a reload and the Back button stay on
  // the page. It is read here, not at module load, so the launch token has
  // already been taken out of the address by api.ts.
  const [place, setPlace] = useState<Place>(() =>
    parsePlace(window.location.hash),
  );
  const [theme, setThemeChoice] = useState<ThemeChoice>(() => readTheme());
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
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
  const [packageSeed, setPackageSeed] = useState<PackageSeed | null>(null);
  // The result of the last export of the registry.
  const [exportStatus, setExportStatus] = useState<string>('');
  const [search, setSearch] = useState('');
  // The search and the status filter of the connector list.
  const [connectorSearch, setConnectorSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ConnectorFilter>('all');

  // The newest refresh owns the page, and every refresh is bounded, so a
  // stalled hub never leaves the page loading. See latestRunner.
  const [runRefresh] = useState(() => latestRunner(REFRESH_LIMIT_MS));
  const refresh = useCallback(
    () =>
      runRefresh({
        begin: () => {
          setLoading(true);
          setError('');
        },
        work: (signal, current) => loadHub(signal, current),
        fail: (error) =>
          setError(
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'The hub did not answer in time. Refresh to retry.'
              : error instanceof Error
                ? error.message
                : 'The hub is unavailable.',
          ),
        end: () => setLoading(false),
      }),
    [runRefresh],
  );
  async function loadHub(signal: AbortSignal, current: () => boolean) {
    // The session request is shared and keeps running for a later refresh;
    // only this wait on it is bounded.
    await untilAborted(sessionReady, signal);
    const [
      info,
      profileResult,
      agentResult,
      events,
      security,
      recovery,
      connectorResult,
    ] = await Promise.all([
      api('/api/bootstrap', undefined, signal),
      api<{
        profiles: Profile[];
        revision: number;
        materializations: Array<Materialization & { stale: boolean }>;
      }>('/api/profiles', undefined, signal),
      api<{ agents: Array<AgentObservation & Partial<DiscoveredAgent>> }>(
        '/api/agents',
        undefined,
        signal,
      ),
      api<{ events: HubState['activity'] }>('/api/activity', undefined, signal),
      api<{ events: SecurityEvent[] }>(
        '/api/security-activity',
        undefined,
        signal,
      ),
      api<{ blocked: boolean }>('/api/recovery', undefined, signal),
      api<{
        connectors: ManagedConnector[];
        observations: CapabilityObservation[];
      }>('/api/connectors', undefined, signal),
    ]);
    const parsed = BootstrapSchema.parse(info);
    // Every read finishes before anything is committed, so a failed or late
    // discovery read never leaves a mixed snapshot on the page.
    const discovered = parsed.capabilities.discovery
      ? await Promise.all([
          api<DiscoverySnapshot>('/api/discovery', undefined, signal),
          api<AdoptionPreview>('/api/adoption/preview', undefined, signal),
        ])
      : null;
    if (!current()) return;
    setBootstrap({ ...parsed, revision: profileResult.revision });
    setProfiles(profileResult.profiles);
    setConnectors(connectorResult.connectors);
    setObservations(connectorResult.observations);
    setMaterializations(profileResult.materializations);
    setAgents(agentResult.agents);
    setActivity(events.events);
    setSecurityEvents(security.events);
    setRecoveryBlocked(recovery.blocked);
    // Always assigned, so a capability that went away clears its old data.
    setDiscovery(discovered?.[0] ?? null);
    setAdoption(discovered?.[1] ?? null);
  }
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // The place as the address handlers see it, without waiting for a render.
  const placeNow = useRef(place);
  const show = useCallback((next: Place) => {
    placeNow.current = next;
    setPlace(next);
  }, []);
  // An Add page that waits on the hub holds the place. As a dialog it was
  // modal, so nothing could leave it mid-request and lose the outcome.
  const holding = useRef(false);
  const [held, setHeld] = useState(false);
  const hold = useCallback((busy: boolean) => {
    holding.current = busy;
    setHeld(busy);
  }, []);
  // Every history entry of the app carries its position, so a refused Back
  // or Forward can be undone instead of overwriting the entry it landed on.
  const position = useRef(0);
  // A refused traversal is undone with another traversal, which lands a
  // moment later. A close that arrives in between is shown at once and gets
  // its history entry when the undo has landed.
  const undoing = useRef(false);
  const closeAfterUndo = useRef<Place | null>(null);
  const push = useCallback((next: Place) => {
    position.current += 1;
    window.history.pushState({ position: position.current }, '', address(next));
  }, []);
  useEffect(() => {
    const known = positionOf(window.history.state);
    if (known === null) window.history.replaceState({ position: 0 }, '');
    else position.current = known;
    const read = () => {
      const next = parsePlace(window.location.hash);
      const landed = positionOf(window.history.state);
      if (undoing.current) {
        // Only the entry the undo was sent to ends it. Another Back or
        // Forward in between is sent there as well.
        if (landed !== position.current) {
          if (landed === null) window.history.back();
          else window.history.go(position.current - landed);
          return;
        }
        undoing.current = false;
        const closed = closeAfterUndo.current;
        closeAfterUndo.current = null;
        if (closed) {
          push(closed);
          return;
        }
      }
      if (holding.current && !samePlace(next, placeNow.current)) {
        // Refused during the wait. A pill or a typed address made a new
        // entry: step back off it. Back or Forward landed on an old entry:
        // return to the entry it came from.
        if (landed === null) {
          undoing.current = true;
          window.history.back();
        } else if (landed !== position.current) {
          undoing.current = true;
          window.history.go(position.current - landed);
        } else
          window.history.replaceState(
            window.history.state,
            '',
            address(placeNow.current),
          );
        return;
      }
      if (landed === null) {
        position.current += 1;
        window.history.replaceState({ position: position.current }, '');
      } else position.current = landed;
      show(next);
    };
    // A traversal between two entries of the same address fires no
    // hashchange, so the position is also read here. A traversal that the
    // hold is about to refuse keeps the old position: the refusal needs it.
    const settle = (event: PopStateEvent) => {
      const landed = positionOf(event.state);
      if (
        landed !== null &&
        !undoing.current &&
        (!holding.current ||
          samePlace(parsePlace(window.location.hash), placeNow.current))
      )
        position.current = landed;
    };
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', settle);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', settle);
    };
  }, [show, push]);
  // The drafts whose discard the hub did not confirm when their page was
  // left. Each one is kept, retried and forgotten on its own.
  const [strandedDrafts, setStrandedDrafts] = useState<string[]>([]);
  const forgetDraft = useCallback(
    (id: string) =>
      setStrandedDrafts((drafts) => drafts.filter((draft) => draft !== id)),
    [],
  );
  const strandDraft = useCallback(
    (id: string) => {
      setStrandedDrafts((drafts) => [...drafts, id]);
      // The hub drops the draft by itself when its lifetime ends.
      window.setTimeout(() => forgetDraft(id), DRAFT_LIFETIME_MS);
    },
    [forgetDraft],
  );
  async function retryDiscard(id: string) {
    try {
      await api(`/api/imports/${id}/cancel`, {});
    } catch (failure) {
      // A draft the hub no longer knows is gone, which is the goal.
      if (!(failure instanceof ApiError && failure.status === 404)) return;
    }
    forgetDraft(id);
  }
  // While the hub has not answered, every tab is shown. Once it has, a place
  // that a capability hides moves to its first visible sibling, in place.
  useEffect(() => {
    // A held page stays: the address may be mid-way through a refused move,
    // also for a moment after the page has closed.
    if (!bootstrap || holding.current || undoing.current) return;
    // Read from the address, not from the state: a pill that was just
    // followed has changed the address, and its hashchange may still be
    // queued.
    const asked = parsePlace(window.location.hash);
    const fixed = resolvePlace(asked, bootstrap.capabilities);
    if (samePlace(fixed, asked)) return;
    window.history.replaceState(window.history.state, '', address(fixed));
    show(fixed);
  }, [bootstrap, place, show]);
  // A move to another place is a new history entry.
  const move = useCallback(
    (next: Place) => {
      if (undoing.current) {
        // The address is mid-way through an undo: do not trust it.
        closeAfterUndo.current = next;
        show(next);
        return;
      }
      if (samePlace(placeNow.current, next)) return;
      // A Back that already changed the address to this place, with its
      // hashchange still queued, is the move: it needs no entry of its own.
      if (!samePlace(parsePlace(window.location.hash), next)) push(next);
      show(next);
    },
    [show, push],
  );
  // The navigation of the user. It waits while an Add page holds the place.
  const go = useCallback(
    (next: Place) => {
      if (!holding.current) move(next);
    },
    [move],
  );
  // An Add page closes itself to the list of connectors, also while it holds
  // the place: closing is how its own request ends.
  const closeAdd = () => move({ entry: 'connectors', tab: 'all' });
  const entry = entryOf(place.entry);
  const page = entry.label;
  const capabilities = bootstrap?.capabilities ?? null;
  const tabs = visibleTabs(entry, capabilities);
  const currentTab = tabs.find((tab) => tab.id === place.tab);
  const pills = currentTab ? visiblePills(currentTab, capabilities) : [];
  const onAdd = place.entry === 'connectors' && place.tab === 'add';
  // The safety notice belongs to Settings › Runtime & safeguards and the Add
  // pages only.
  const showNotice =
    onAdd || (place.entry === 'settings' && place.tab === 'runtime');
  const update = useUpdateCheck(!!bootstrap?.capabilities.appUpdates);

  const filteredProfiles = profiles.filter((profile) =>
    `${profile.name} ${profile.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  // The connector list shows the rows the search and the status filter keep.
  const visibleConnectors = connectors.filter(
    (connector) =>
      connectorMatches(connector, connectorSearch) &&
      (statusFilter === 'all' ||
        connectorStatus(connector, observations) === statusFilter),
  );
  const visibleIds = new Set(
    visibleConnectors.map((connector) => connector.id),
  );
  const clearConnectorFilters = () => {
    setConnectorSearch('');
    setStatusFilter('all');
  };
  // The export of the registry. The hub writes the files; the browser only
  // saves them. No credential value is part of an export.
  async function exportRegistry() {
    setExportStatus('');
    try {
      const result = await api<ConnectorExport>('/api/connectors/export');
      const stamp = new Date().toISOString().slice(0, 10);
      result.parts.forEach((part, index) => {
        downloadPart(
          exportFileName(index + 1, result.parts.length, stamp),
          part,
        );
      });
      const files = result.parts.length
        ? `Exported ${result.parts.length} file${result.parts.length === 1 ? '' : 's'}`
        : 'No connectors to export.';
      const skipped = result.skipped.length
        ? `. Not exported: ${result.skipped
            .map((connector) => `${connector.name} (${connector.reason})`)
            .join(', ')}`
        : '';
      setExportStatus(`${files}${skipped}`);
    } catch (failure) {
      setExportStatus(
        failure instanceof Error
          ? failure.message
          : 'The export failed. Check the terminal and retry.',
      );
    }
  }

  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice);
    setThemeChoice(choice);
  }
  function stopDesktop() {
    void api('/api/desktop/shutdown', {})
      .then(() =>
        setError('Desktop manager stopped. You can close this window.'),
      )
      .catch(() => setError('Shutdown could not be confirmed.'));
  }

  return (
    <div className="app-shell" data-held={held || undefined}>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          // The link would replace the page address with #main.
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
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
          {entries.map((item) => (
            <Fragment key={item.id}>
              <button
                className={
                  place.entry === item.id ? 'nav-item selected' : 'nav-item'
                }
                aria-current={place.entry === item.id ? 'page' : undefined}
                aria-disabled={held || undefined}
                onClick={() => {
                  // A held page keeps its filters too.
                  if (held) return;
                  go(firstPlace(item, capabilities));
                  setSearch('');
                  setConnectorSearch('');
                  setStatusFilter('all');
                }}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.id === 'settings' &&
                  update.status?.state === 'available' && (
                    // Visual only: the status text below names it, so the
                    // accessible name of the button stays "Settings".
                    <span className="nav-count" aria-hidden="true">
                      1
                    </span>
                  )}
                {item.id === 'profiles' && profiles.length > 0 && (
                  <span className="nav-count">{profiles.length}</span>
                )}
              </button>
              {item.id === 'settings' &&
                update.status?.state === 'available' && (
                  <span className="sr-only" role="status">
                    Update available
                  </span>
                )}
            </Fragment>
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
          {bootstrap?.version && (
            <span className="stage-label">
              <span className="version" title="Installed version">
                v{bootstrap.version}
              </span>
            </span>
          )}
        </header>
        {tabs.length > 1 && (
          <TabRow
            entry={entry}
            tabs={tabs}
            current={currentTab?.id}
            held={held}
            open={(tab) => go(firstPlace(entry, capabilities, tab))}
          />
        )}
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">MCP CONTROL PANEL</div>
              <h1>{page}</h1>
              <p>{entry.description}</p>
            </div>
            {place.entry === 'profiles' ? (
              <button
                className="primary"
                disabled={loading || !!error || recoveryBlocked}
                onClick={() => setCreating(true)}
              >
                <Icon name="plus" size={18} />
                Create profile
              </button>
            ) : place.entry === 'connectors' ? (
              <div className="action-with-help">
                <div className="page-actions">
                  <button
                    type="button"
                    disabled={loading || !!error || recoveryBlocked}
                    aria-disabled={held || undefined}
                    onClick={() => go(addPlace('manual'))}
                  >
                    <Icon name="upload" size={16} />
                    Add Manual MCP
                  </button>
                  <button
                    type="button"
                    disabled={loading || !!error || held}
                    aria-describedby="export-help"
                    onClick={() => {
                      void exportRegistry();
                    }}
                  >
                    <Icon name="download" size={16} />
                    Export
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={loading || !!error}
                    aria-disabled={held || undefined}
                    onClick={() => go(addPlace('import'))}
                    aria-describedby="add-help"
                  >
                    <Icon name="plus" size={18} />
                    Add connector
                  </button>
                </div>
                <small id="add-help">
                  Preview first · saving and execution are separate
                </small>
                <small id="export-help">
                  Secrets are never exported; credential names are.
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

          <TabPanel
            entry={entry}
            capabilities={capabilities}
            current={currentTab?.id}
          >
            {place.tab === 'add' && (
              <PillRow
                label="Add a connector"
                pills={pills}
                current={place.pill}
                held={held}
                href={(pill) => formatPlace({ ...place, pill })}
              />
            )}
            {/* Export is offered on both Connectors tabs, so is its result. */}
            {place.entry === 'connectors' && exportStatus && (
              <p className="notice" role="status" data-testid="export-status">
                {exportStatus}
              </p>
            )}

            {/* Above every page while changes are blocked, also when the
                hub can no longer be read. */}
            {recoveryBlocked && (
              <section className="error-panel" role="alert">
                <h2>Recovery review required</h2>
                <p>
                  An unfinished operation needs recovery review. Further changes
                  are blocked; nothing will be replayed or rolled back
                  automatically. Inspect the local runtime using the README
                  recovery instructions before retrying.
                </p>
                <a href="/api/recovery" target="_blank" rel="noreferrer">
                  Inspect recovery metadata
                </a>
              </section>
            )}
            {strandedDrafts.length > 0 && (
              <section className="error-panel" role="alert">
                <h2>
                  {strandedDrafts.length === 1
                    ? 'A private import draft was not discarded'
                    : `${strandedDrafts.length} private import drafts were not discarded`}
                </h2>
                <p>
                  The import page was left, but the hub did not confirm that its
                  draft is gone. A draft expires within five minutes.
                </p>
                <button
                  onClick={() => {
                    for (const id of strandedDrafts) void retryDiscard(id);
                  }}
                >
                  Retry discard
                </button>
              </section>
            )}
            {showNotice && (
              <div className="foundation-notice">
                <Icon name="shield" />
                <div>
                  {bootstrap?.capabilities.discovery
                    ? 'Discovery does not execute connectors; saving, exact execution approval, protected credentials, profile apply and capability checks are separate actions, and pilot adoption and agent synchronization stay disabled.'
                    : bootstrap?.capabilities.agentApply
                      ? 'Save definitions locally, approve exact execution separately, and manage protected credentials explicitly; agent integration verifies configuration only, and reconnect and trust remain agent-controlled.'
                      : 'Save definitions locally, approve exact execution separately, and manage protected credentials explicitly; capability tests use available runtime adapters, and agent synchronization remains disabled.'}
                </div>
                <span className="read-only-tag">Explicit actions only</span>
              </div>
            )}
            {/* The agent and discovery panels keep their state and their
                timers: they stay mounted and are only hidden when their page
                is not open. */}
            {bootstrap?.capabilities.agentCloning && (
              <div hidden={!(onAdd && place.pill === 'agents')}>
                <AgentCloning
                  disabled={loading || !!error || recoveryBlocked}
                  refresh={refresh}
                  openManual={() => go(addPlace('manual'))}
                />
              </div>
            )}
            {error ? (
              <>
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
                {place.entry === 'settings' && place.tab === 'runtime' && (
                  <AppearancePanel theme={theme} choose={chooseTheme} />
                )}
              </>
            ) : loading && !bootstrap ? (
              <div className="loading-state" role="status">
                Opening your local workspace…
              </div>
            ) : (
              <>
                {bootstrap?.capabilities.appUpdates &&
                  place.entry === 'settings' &&
                  place.tab === 'updates' && <UpdateNotice {...update} />}
                {bootstrap?.capabilities.discovery && (
                  <div hidden={!(onAdd && place.pill === 'discover')}>
                    <DiscoveryPanel
                      snapshot={discovery}
                      preview={adoption}
                      refresh={refresh}
                    />
                  </div>
                )}
                {place.entry === 'connectors' && (
                  // The list stays mounted on the Add tab: it owns the
                  // automatic discovery of all connectors.
                  <section
                    className="list-panel"
                    aria-labelledby="connector-list-title"
                    hidden={place.tab !== 'all'}
                  >
                    <div className="list-toolbar">
                      <div className="list-toolbar-title">
                        <h2 id="connector-list-title">
                          Your connectors{' '}
                          <span className="count">
                            {visibleConnectors.length}
                          </span>
                        </h2>
                        {visibleConnectors.length !== connectors.length && (
                          <span className="muted">of {connectors.length}</span>
                        )}
                        <span className="muted">
                          Desired state · not a live verification
                        </span>
                      </div>
                      <div className="list-toolbar-controls">
                        <div className="search">
                          <Icon name="search" size={16} />
                          <input
                            type="search"
                            aria-label="Search connectors"
                            placeholder="Name, id or target…"
                            value={connectorSearch}
                            onChange={(event) =>
                              setConnectorSearch(event.target.value)
                            }
                          />
                        </div>
                        <div
                          className="segmented"
                          role="group"
                          aria-label="Filter connectors by status"
                        >
                          {connectorFilters.map((filter) => (
                            <button
                              key={filter.id}
                              type="button"
                              aria-pressed={statusFilter === filter.id}
                              onClick={() => setStatusFilter(filter.id)}
                            >
                              {filter.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {/* Without automatic discovery nothing settles, so the bar
                      would stay in its loading state. */}
                    {bootstrap?.capabilities.runtimeChecks &&
                      !recoveryBlocked && (
                        <DiscoveryProgress
                          connectors={connectors}
                          observations={observations}
                        />
                      )}
                    {connectors.length === 0 ? (
                      <div className="empty-state">
                        <div className="empty-icon">
                          <Icon name="connectors" size={28} />
                        </div>
                        <h2>Your existing tools stay where they are</h2>
                        <p>
                          {discovery?.checkedAt
                            ? 'Read-only observations are available in the adoption preview under Add › Discover environment. No connector definition has been imported into the registry or executed.'
                            : 'The hub has not inspected or imported your pilot yet. Use read-only discovery to review your existing setup; adoption remains a separate explicit step.'}
                        </p>
                        {bootstrap?.capabilities.discovery && (
                          <button
                            onClick={() =>
                              go({
                                entry: 'connectors',
                                tab: 'add',
                                pill: 'discover',
                              })
                            }
                          >
                            Open discovery <Icon name="arrow" size={16} />
                          </button>
                        )}
                        <button onClick={() => go({ entry: 'profiles' })}>
                          Set up a local profile <Icon name="arrow" size={16} />
                        </button>
                        <small>
                          Creating a profile does not register tools with
                          agents.
                        </small>
                      </div>
                    ) : (
                      // The list stays mounted while a filter hides every row:
                      // it owns the automatic discovery of all connectors.
                      <>
                        {visibleConnectors.length === 0 && (
                          <div
                            className="empty-state"
                            data-testid="connector-no-match"
                          >
                            <div className="empty-icon">
                              <Icon name="filter" size={28} />
                            </div>
                            <h2>No connectors match</h2>
                            <p>
                              No connector matches the current search and status
                              filter.
                            </p>
                            <button
                              type="button"
                              onClick={clearConnectorFilters}
                            >
                              Clear filters
                            </button>
                          </div>
                        )}
                        <ConnectorList
                          connectors={connectors}
                          visibleIds={visibleIds}
                          revision={bootstrap?.revision ?? 0}
                          observations={observations}
                          observe={setObservations}
                          profiles={profiles}
                          disabled={recoveryBlocked}
                          runtime={!!bootstrap?.capabilities.runtimeChecks}
                          secrets={!!bootstrap?.capabilities.secrets}
                          authenticate={setAuthentication}
                          operate={setOperation}
                          refresh={refresh}
                          openPackage={setPackageSeed}
                        />
                      </>
                    )}
                    <div className="panel-footer">
                      <Icon name="lock" size={15} />
                      Saving is not execution. Capability discovery calls no
                      tools.
                      <span className="panel-footer-note">
                        Definitions, verification and desired profile membership
                      </span>
                    </div>
                  </section>
                )}
                {place.entry === 'profiles' && (
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
                                  record.profileId === profile.id &&
                                  record.stale,
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
                      Registry revision {bootstrap?.revision} · Changes require
                      a preview before apply
                    </div>
                  </section>
                )}
                {place.entry === 'agents' &&
                  bootstrap?.capabilities.agentApply && (
                    <AgentIntegrations
                      revision={bootstrap.revision}
                      blocked={recoveryBlocked}
                      refresh={refresh}
                    />
                  )}
                {place.entry === 'agents' &&
                  !bootstrap?.capabilities.agentApply && (
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
                                      <summary>
                                        Observed user configuration
                                      </summary>
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
                                  Executable, version, and configuration have
                                  not been inspected.
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
                {place.entry === 'activity' && (
                  <ActivityPage
                    tab={place.tab}
                    activity={activity}
                    securityEvents={securityEvents}
                  />
                )}
                {place.entry === 'settings' && place.tab === 'runtime' && (
                  <RuntimeSettings
                    bootstrap={bootstrap}
                    discovery={discovery}
                    recoveryBlocked={recoveryBlocked}
                    theme={theme}
                    chooseTheme={chooseTheme}
                    stopDesktop={stopDesktop}
                  />
                )}
                {place.entry === 'settings' && place.tab === 'recovery' && (
                  <RecoveryStatus blocked={recoveryBlocked} />
                )}
              </>
            )}
            {/* The Add pages are not dialogs: only the page of the open pill is
                rendered, and leaving it discards its form. */}
            {onAdd && place.pill === 'import' && bootstrap && (
              <ImportDialog
                revision={bootstrap.revision}
                close={closeAdd}
                hold={hold}
                stranded={strandDraft}
                refresh={refresh}
                savePreview={(preview, definitions) => {
                  closeAdd();
                  setOperation({
                    title: 'Save connector definitions locally',
                    operation: { kind: 'create_connectors', definitions },
                    context: definitions,
                    initialPreview: preview,
                  });
                }}
                installBlocked={recoveryBlocked}
                installProposal={(proposal: PackageProposal) => {
                  // The import page stays open: the package is installed in its own,
                  // separate review step.
                  const version = proposal.version ?? proposal.requestedVersion;
                  setPackageSeed({
                    mode: 'install',
                    name: proposal.name,
                    ...(version ? { version } : {}),
                    arguments: proposal.arguments,
                    envNames: proposal.envNames,
                    // The metadata of the imported connector travels with the
                    // install, so the connector keeps its name, identifier,
                    // description, enabled flag and literals.
                    ...(proposal.connectorName
                      ? { connectorName: proposal.connectorName }
                      : {}),
                    ...(proposal.connectorId
                      ? { connectorId: proposal.connectorId }
                      : {}),
                    ...(proposal.description !== undefined
                      ? { description: proposal.description }
                      : {}),
                    ...(proposal.entry ? { entry: proposal.entry } : {}),
                    ...(proposal.enabled !== undefined
                      ? { enabled: proposal.enabled }
                      : {}),
                    ...(proposal.environmentLiterals
                      ? { environmentLiterals: proposal.environmentLiterals }
                      : {}),
                  });
                }}
              />
            )}
            {/* The header button to this page is disabled while changes are
                blocked or the hub cannot be read; its pill and its address
                must not get around that. */}
            {onAdd && place.pill === 'manual' && bootstrap && (
              <ManualMcpPage
                blocked={
                  recoveryBlocked
                    ? 'Adding an MCP by hand is blocked until the recovery review is done.'
                    : error
                      ? 'Adding an MCP by hand is unavailable until the workspace loads again.'
                      : null
                }
                revision={bootstrap.revision}
                close={closeAdd}
                hold={hold}
                refresh={refresh}
              />
            )}
          </TabPanel>
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
      {packageSeed && (
        <PackageDialog
          seed={packageSeed}
          close={() => setPackageSeed(null)}
          refresh={refresh}
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
      {authentication && bootstrap && (
        <AuthDialog
          connector={authentication}
          revision={bootstrap.revision}
          close={() => setAuthentication(null)}
          refresh={refresh}
        />
      )}
    </div>
  );
}
