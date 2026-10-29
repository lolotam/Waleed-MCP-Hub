import { useState } from 'react';
import type {
  CapabilityObservation,
  Connector,
  ImportDefinition,
  Profile,
  RuntimeJob,
} from '@waleed/contracts';
import type { OperationDialogInput } from './OperationDialog.js';
import { api } from './api.js';

export type ManagedConnector = Connector & { executionHash: string };
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
  return connector.executionMode === 'native'
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
        };
}
export function ConnectorList({
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
      const deadline = Date.now() + 65_000;
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
      <ul className="connector-list">
        {connectors.map((connector) => {
          const observation = observations.find(
            (entry) => entry.connectorId === connector.id,
          );
          const approval =
            connector.trustApproval?.revision === connector.revision &&
            connector.trustApproval.definitionHash === connector.executionHash;
          const secretBacked =
            Object.keys(connector.secretBindings).length > 0 ||
            Object.keys(connector.headerBindings).length > 0;
          const state = observation?.state ?? 'untested';
          const tone =
            state === 'connected'
              ? 'ok'
              : state === 'untested' || state === 'checking'
                ? 'idle'
                : 'warn';
          const toolCount =
            state === 'connected' ? (observation?.tools.length ?? 0) : null;
          const target =
            connector.executionMode === 'native'
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
        Test capabilities
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
