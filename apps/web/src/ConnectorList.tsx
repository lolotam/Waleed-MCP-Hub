import { useEffect, useState } from 'react';
import {
  ToolPolicyNameSchema,
  ConnectorHealthResponseSchema,
  type ConnectorHealth,
  type ToolPolicy,
  type ToolOverride,
} from '@waleed/contracts';
import type {
  CapabilityObservation,
  Connector,
  ImportDefinition,
  Profile,
  RuntimeJob,
} from '@waleed/contracts';
import type { OperationDialogInput } from './OperationDialog.js';
import { api } from './api.js';
import { ToolOverrideDialog } from './ToolOverrideDialog.js';

export type ManagedConnector = Connector & {
  executionHash: string;
  toolOverrides?: ToolOverride[];
};
export function editableDefinition(
  connector: ManagedConnector,
): ImportDefinition {
  const common = {
    id: connector.id,
    name: connector.name,
    description: connector.description,
    enabled: connector.enabled,
    environmentLiterals: connector.environmentLiterals ?? {},
    secretBindings: connector.secretBindings,
    headerBindings: connector.headerBindings,
    ...(connector.credentialFormats
      ? { credentialFormats: connector.credentialFormats }
      : {}),
    trustApproval: null,
  };
  return connector.executionMode === 'package'
    ? {
        ...common,
        executionMode: 'package',
        transport: 'stdio',
        package: connector.package,
        arguments: connector.arguments,
      }
    : connector.executionMode === 'native'
      ? {
          ...common,
          executionMode: 'native',
          transport: 'stdio',
          executable: connector.executable,
          arguments: connector.arguments,
        }
      : connector.executionMode === 'docker'
        ? {
            ...common,
            executionMode: 'docker',
            transport: 'stdio',
            image: connector.image,
            ...(connector.portBindings
              ? { portBindings: connector.portBindings }
              : {}),
            command: connector.command ?? [],
            arguments: connector.arguments,
          }
        : {
            ...common,
            executionMode: 'remote',
            transport: connector.transport,
            endpoint: connector.endpoint,
            ...(connector.localHttpOptIn !== undefined
              ? { localHttpOptIn: connector.localHttpOptIn }
              : {}),
          };
}
export function ConnectorList({
  revision,
  connectors,
  observations,
  profiles,
  disabled,
  runtime,
  secrets,
  authenticate,
  operate,
  refresh,
}: {
  revision: number;
  connectors: ManagedConnector[];
  observations: CapabilityObservation[];
  profiles: Profile[];
  disabled: boolean;
  runtime: boolean;
  secrets: boolean;
  authenticate: (connector: ManagedConnector) => void;
  operate: (input: OperationDialogInput) => void;
  refresh: () => Promise<void>;
}) {
  const [job, setJob] = useState<RuntimeJob | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState<ConnectorHealth[]>([]),
    [healthRunning, setHealthRunning] = useState(false),
    [healthNotice, setHealthNotice] = useState('');
  const [liveObservations, setLiveObservations] = useState<
    CapabilityObservation[]
  >([]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    setLiveObservations([]);
    const load = async () => {
      try {
        const [raw, inventory] = await Promise.all([
          api('/api/health/connectors'),
          api<{ observations: CapabilityObservation[] }>('/api/connectors'),
        ]);
        const result = ConnectorHealthResponseSchema.parse(raw);
        if (!stopped) {
          setHealth(result.connectors);
          setHealthRunning(result.running);
          setLiveObservations(inventory.observations);
          setHealthNotice((current) =>
            current.startsWith('Health status is unavailable') ? '' : current,
          );
        }
      } catch {
        if (!stopped)
          setHealthNotice(
            'Health status is unavailable; displayed badges may be stale.',
          );
      } finally {
        if (!stopped) timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [revision]);
  // Rows stay compact; details open in place and several may be open at once.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  async function check(id: string) {
    setChecking(true);
    setError('');
    try {
      let current = await api<RuntimeJob>(`/api/connectors/${id}/check`, {});
      setJob(current);
      const deadline =
        Date.now() +
        (connectors.find((item) => item.id === id)?.executionMode === 'package'
          ? 165_000
          : 65_000);
      while (current.state === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        current = await api<RuntimeJob>(`/api/runtime/jobs/${current.id}`);
        setJob(current);
      }
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Check failed.');
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      <div className="health-toolbar">
        <button
          disabled={disabled || !runtime || healthRunning}
          onClick={() => {
            setHealthNotice('');
            void api('/api/health/retest', {})
              .then(() => {
                setHealthNotice(
                  'Health checks requested. Results update automatically.',
                );
                setHealthRunning(true);
              })
              .catch(() =>
                setHealthNotice(
                  'Health checks could not start. Review approval and recovery.',
                ),
              );
          }}
        >
          {healthRunning ? 'Checking health…' : 'Check Health'}
        </button>
        <small className="muted">Discovery only · no tool calls</small>
        {healthNotice && <span role="status">{healthNotice}</span>}
      </div>
      <ul className="connector-list">
        {connectors.map((connector) => {
          const liveObservation = liveObservations.find(
            (entry) =>
              entry.connectorId === connector.id &&
              entry.revision === connector.revision &&
              entry.definitionHash === connector.executionHash,
          );
          const inventoryObservation = observations.find(
            (entry) => entry.connectorId === connector.id,
          );
          // Polling can finish after an explicit check has refreshed inventory.
          // Never let an older same-revision snapshot erase the newer result.
          const observation =
            liveObservation &&
            (!inventoryObservation ||
              (liveObservation.checkedAt ?? '') >
                (inventoryObservation.checkedAt ?? ''))
              ? liveObservation
              : inventoryObservation;
          const approval =
            connector.trustApproval?.revision === connector.revision &&
            connector.trustApproval.definitionHash === connector.executionHash;
          const secretBacked =
            Object.keys(connector.secretBindings).length > 0 ||
            Object.keys(connector.headerBindings).length > 0;
          const state = observation?.state ?? 'untested';
          const connectorHealth = health.find(
              (entry) =>
                entry.connectorId === connector.id &&
                entry.revision === connector.revision,
            ),
            needsReauth = connectorHealth?.status === 'needs_reauth';
          const tone = needsReauth
            ? 'warn'
            : state === 'connected'
              ? 'ok'
              : state === 'untested' || state === 'checking'
                ? 'idle'
                : 'warn';
          const toolCount =
            state === 'connected' ? (observation?.tools.length ?? 0) : null;
          const target =
            connector.executionMode === 'package'
              ? `${connector.package.manager === 'npm' ? 'npx' : 'uvx'} ${connector.package.name}${connector.package.manager === 'npm' ? '@' : '=='}${connector.package.version} → ${connector.package.entryPoint}`
              : connector.executionMode === 'native'
                ? [connector.executable, ...connector.arguments].join(' ')
                : connector.executionMode === 'docker'
                  ? connector.image
                  : connector.endpoint;
          const expanded = open.has(connector.id);
          const panelId = `connector-panel-${connector.id}`;
          return (
            <li
              key={connector.id}
              data-testid={`connector-${connector.id}`}
              className={expanded ? 'is-open' : undefined}
            >
              <button
                type="button"
                className="connector-summary"
                data-testid="connector-toggle"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => toggle(connector.id)}
              >
                <span
                  className={`status-dot ${connector.enabled ? tone : 'off'}`}
                  aria-hidden="true"
                />
                <span className="connector-name">
                  <strong>{connector.name}</strong>
                  <small title={target}>{target}</small>
                </span>
                <span className="cell cell-runtime">
                  {connector.executionMode}
                </span>
                <span className="pills">
                  {needsReauth && (
                    <span
                      className="pill reauth"
                      aria-label={`Needs Re-auth for ${connector.name}`}
                    >
                      Needs Re-auth
                    </span>
                  )}
                  {Object.values(connector.toolPolicies ?? {}).filter(
                    (policy) => policy === 'block',
                  ).length > 0 && (
                    <span className="pill warn">
                      {
                        Object.values(connector.toolPolicies ?? {}).filter(
                          (policy) => policy === 'block',
                        ).length
                      }{' '}
                      blocked
                    </span>
                  )}
                  <span className={`pill ${connector.enabled ? tone : 'off'}`}>
                    {connector.enabled
                      ? state.replaceAll('_', ' ')
                      : 'disabled'}
                  </span>
                  <span className={`pill ${approval ? 'ok' : 'warn'}`}>
                    {approval ? 'Approved' : 'Needs approval'}
                  </span>
                </span>
                <span className="cell cell-tools">
                  {toolCount === null ? '—' : `${toolCount} tools`}
                </span>
                <span className="chevron" aria-hidden="true" />
              </button>
              {needsReauth && (
                <div className="connector-reauth-actions">
                  <span>Sign-in or token renewal is required.</span>
                  <button
                    disabled={disabled || !secrets}
                    aria-label={`Re-authenticate ${connector.name}`}
                    onClick={() => authenticate(connector)}
                  >
                    Re-authenticate
                  </button>
                </div>
              )}
              {expanded && (
                <div className="connector-panel" id={panelId}>
                  <div
                    className="row-actions"
                    role="group"
                    aria-label={`Actions for ${connector.name}`}
                  >
                    <ConnectorActions
                      connector={connector}
                      approval={approval}
                      secretBacked={secretBacked}
                      disabled={disabled}
                      runtime={runtime}
                      secrets={secrets}
                      checking={checking}
                      authenticate={authenticate}
                      operate={operate}
                      check={(id) => void check(id)}
                    />
                  </div>
                  <dl className="connector-facts">
                    <div>
                      <dt>Runtime</dt>
                      <dd>
                        {connector.executionMode} · revision{' '}
                        {connector.revision} ·{' '}
                        {connector.enabled ? 'enabled' : 'disabled'}
                      </dd>
                    </div>
                    <div>
                      <dt>Approval</dt>
                      <dd>
                        {approval ? 'execution approved' : 'approval required'}
                      </dd>
                    </div>
                    <div>
                      <dt>Last check</dt>
                      <dd>
                        {state} ·{' '}
                        {observation?.method === 'mcp_discovery'
                          ? 'MCP discovery only — no tool executed'
                          : 'not verified'}
                        {observation?.checkedAt
                          ? ` · ${new Date(observation.checkedAt).toLocaleString()}`
                          : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Profiles</dt>
                      <dd>
                        {profiles
                          .filter((profile) =>
                            profile.connectorIds.includes(connector.id),
                          )
                          .map((profile) => profile.name)
                          .join(', ') || 'none'}{' '}
                        · agent synchronization: not applied
                      </dd>
                    </div>
                    <div className="wide">
                      <dt>
                        {connector.executionMode === 'remote'
                          ? 'Endpoint'
                          : connector.executionMode === 'docker'
                            ? 'Image'
                            : connector.executionMode === 'package'
                              ? 'Pinned package'
                              : 'Command'}
                      </dt>
                      <dd>
                        <code>{target}</code>
                      </dd>
                    </div>
                  </dl>
                  {observation?.reason && observation.reason !== 'none' && (
                    <p className="notice">
                      {observation.reason.replaceAll('_', ' ')}
                    </p>
                  )}
                  {secretBacked && (
                    <p className="notice">
                      {connector.executionMode === 'docker'
                        ? 'Docker secret references are supported in snapshots; direct secret-backed image checks are unavailable.'
                        : 'Protected credentials are resolved only for this connector. Save success is not authentication verification.'}
                    </p>
                  )}
                  <details>
                    <summary>Definition and capabilities</summary>
                    <pre>
                      {JSON.stringify(editableDefinition(connector), null, 2)}
                    </pre>
                    <p>
                      {observation?.tools.filter(
                        (tool) => tool.role === 'upstream',
                      ).length ?? 0}{' '}
                      upstream tools ·{' '}
                      {observation?.tools.filter(
                        (tool) => tool.role === 'gateway_management',
                      ).length ?? 0}{' '}
                      gateway-management tools ·{' '}
                      {observation?.resourceCount ?? 0} resources ·{' '}
                      {observation?.promptCount ?? 0} prompts.
                    </p>
                    <ul>
                      {observation?.tools.map((tool) => (
                        <li key={tool.name}>
                          {tool.name} · {tool.role.replaceAll('_', ' ')}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <ToolPermissions
                    connector={connector}
                    observation={observation}
                    revision={revision}
                    disabled={disabled}
                    refresh={refresh}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {job && (
        <div className="panel-footer" role="status">
          Capability check: {job.state} · {job.reason.replaceAll('_', ' ')}
          {checking && (
            <button
              onClick={() => {
                void api(`/api/runtime/jobs/${job.id}/cancel`, {}).catch(() =>
                  setError(
                    'Cancellation could not be confirmed. Inspect the check before retrying.',
                  ),
                );
              }}
            >
              Cancel check
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
function ToolPermissions({
  connector,
  observation,
  revision,
  disabled,
  refresh,
}: {
  connector: ManagedConnector;
  observation: CapabilityObservation | undefined;
  revision: number;
  disabled: boolean;
  refresh: () => Promise<void>;
}) {
  const [policies, setPolicies] = useState(connector.toolPolicies ?? {}),
    [saving, setSaving] = useState(false),
    [stale, setStale] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [customizing, setCustomizing] = useState<string | null>(null);
  useEffect(() => {
    setPolicies(connector.toolPolicies ?? {});
    setStale(false);
  }, [connector.toolPolicies, revision]);
  const names = [
    ...new Set([
      ...(observation?.tools.map((tool) => tool.name) ?? []),
      ...Object.keys(policies),
      ...(connector.toolOverrides ?? []).map((item) => item.originalToolName),
    ]),
  ].sort();
  const blocked = Object.values(policies).filter(
      (policy) => policy === 'block',
    ).length,
    asked = Object.values(policies).filter((policy) => policy === 'ask').length;
  async function change(name: string, policy: ToolPolicy) {
    const next = { ...policies };
    if (policy === 'allow') delete next[name];
    else next[name] = policy;
    setPolicies(next);
    setSaving(true);
    setError('');
    setMessage('Saving permissions…');
    let saved = false;
    try {
      const result = await api<{ state: string; recoveryRequired: boolean }>(
        `/api/connectors/${connector.id}/tool-policies`,
        {
          expectedRevision: revision,
          expectedConnectorRevision: connector.revision,
          toolPolicies: next,
        },
      );
      saved = true;
      await refresh();
      setMessage(
        result.recoveryRequired
          ? 'Permissions saved; recovery review is required.'
          : 'Permissions saved. The managed bridge rechecks every call.',
      );
    } catch {
      if (!saved) setPolicies(connector.toolPolicies ?? {});
      setStale(true);
      setMessage('');
      setError(
        saved
          ? 'Permissions saved, but inventory refresh failed. Refresh before making another change.'
          : 'Permissions were not confirmed. Refresh inventory before retrying; another window may have changed it.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="tool-permissions">
      <summary>
        Tools &amp; Permissions{' '}
        <span className="pill">
          {names.length} tools · {asked} Ask · {blocked} Blocked
        </span>
      </summary>
      <p>
        Allow runs normally. Ask requires a one-time user confirmation through
        the agent’s elicitation UI; unsupported clients are refused. Block
        removes the tool from the agent’s catalog and rejects stale calls.
        Unconfigured tools default to Allow, including read-only tools.
      </p>
      {!names.length && (
        <p>
          No discovered tools yet. Approve this connector and test capabilities
          first; discovery executes no tools.
        </p>
      )}
      <ul className="tool-policy-list">
        {names.map((name) => {
          const supported = ToolPolicyNameSchema.safeParse(name).success,
            policy = supported ? (policies[name] ?? 'allow') : 'block';
          const override = connector.toolOverrides?.find(
            (item) => item.originalToolName === name,
          );
          return (
            <li key={name}>
              <label>
                <code>{name}</code>
                <select
                  aria-label={`Policy for ${name}`}
                  value={policy}
                  disabled={disabled || saving || stale || !supported}
                  onChange={(event) =>
                    void change(name, event.target.value as ToolPolicy)
                  }
                >
                  <option value="allow">Allow</option>
                  <option value="ask">Ask</option>
                  <option value="block">Block</option>
                </select>
              </label>
              <span className={`pill ${policy === 'allow' ? 'ok' : 'warn'}`}>
                {policy === 'block'
                  ? 'Blocked'
                  : policy === 'ask'
                    ? 'Ask'
                    : 'Allow'}
              </span>
              {override && (
                <span
                  className="pill"
                  title={
                    override.alias
                      ? `Alias: ${override.alias}`
                      : 'Customized tool metadata'
                  }
                >
                  Overridden
                </span>
              )}
              {override?.alias && (
                <small className="tool-alias">
                  Agent name: <code>{override.alias}</code>
                </small>
              )}
              <button
                type="button"
                aria-label={`Customize ${name}`}
                disabled={disabled || saving || stale || !supported}
                onClick={() => setCustomizing(name)}
              >
                Customize
              </button>
              {!supported && (
                <small>
                  Unsupported tool name; omitted by the managed bridge.
                </small>
              )}
            </li>
          );
        })}
      </ul>
      {message && <p role="status">{message}</p>}
      {customizing && (
        <ToolOverrideDialog
          connectorId={connector.id}
          connectorRevision={connector.revision}
          revision={revision}
          toolName={customizing}
          override={connector.toolOverrides?.find(
            (item) => item.originalToolName === customizing,
          )}
          close={() => setCustomizing(null)}
          refresh={refresh}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {stale && (
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void refresh()
              .then(() => {
                setStale(false);
                setError('');
              })
              .catch(() =>
                setError(
                  'Refresh failed. Permissions remain unchanged in this window.',
                ),
              )
              .finally(() => setSaving(false));
          }}
        >
          Refresh permissions
        </button>
      )}
    </details>
  );
}
function ConnectorActions({
  connector,
  approval,
  secretBacked,
  disabled,
  runtime,
  secrets,
  checking,
  authenticate,
  operate,
  check,
}: {
  connector: ManagedConnector;
  approval: boolean;
  secretBacked: boolean;
  disabled: boolean;
  runtime: boolean;
  secrets: boolean;
  checking: boolean;
  authenticate: (connector: ManagedConnector) => void;
  operate: (input: OperationDialogInput) => void;
  check: (id: string) => void;
}) {
  return (
    <>
      <button
        disabled={disabled || !secrets}
        title={
          !secrets
            ? 'A protected credential backend is unavailable.'
            : 'Manage write-only credentials and supported OAuth.'
        }
        onClick={() => authenticate(connector)}
      >
        Authentication
      </button>
      <button
        disabled={disabled}
        onClick={() =>
          operate({
            title: 'Edit connector',
            operation: {
              kind: 'edit_connector',
              connectorId: connector.id,
              definition: editableDefinition(connector),
            },
            editor: 'definition',
            context: editableDefinition(connector),
          })
        }
      >
        Edit
      </button>
      <button
        disabled={disabled || !connector.enabled || approval}
        onClick={() =>
          operate({
            title: 'Approve exact execution definition',
            operation: {
              kind: 'approve_connector',
              connectorId: connector.id,
              expectedConnectorRevision: connector.revision,
              definitionHash: connector.executionHash,
              approveExecution: true,
            },
            context: editableDefinition(connector),
          })
        }
      >
        Approve execution
      </button>
      <button
        disabled={
          disabled ||
          checking ||
          !runtime ||
          !connector.enabled ||
          !approval ||
          (secretBacked && (!secrets || connector.executionMode === 'docker'))
        }
        onClick={() => check(connector.id)}
      >
        {connector.executionMode === 'package'
          ? 'Prepare & test package'
          : 'Test capabilities'}
      </button>
      <button
        disabled={disabled}
        onClick={() =>
          operate({
            title: connector.enabled ? 'Disable connector' : 'Enable connector',
            operation: {
              kind: 'set_connector_enabled',
              connectorId: connector.id,
              enabled: !connector.enabled,
            },
            context: {
              effect:
                'Changes desired state only. Reapply affected profiles and reconnect existing clients. Credentials are retained.',
            },
          })
        }
      >
        {connector.enabled ? 'Disable' : 'Enable'}
      </button>
      <button
        disabled={disabled}
        onClick={() =>
          operate({
            title: 'Remove connector definition',
            operation: {
              kind: 'remove_connector',
              connectorId: connector.id,
            },
            context: {
              effect:
                'Remove definition and desired memberships, not credentials or provider authorization. Reapply affected profiles.',
            },
          })
        }
      >
        Remove
      </button>
    </>
  );
}
