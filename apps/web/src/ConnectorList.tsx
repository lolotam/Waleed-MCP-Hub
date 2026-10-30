import { useEffect, useRef, useState } from 'react';
import {
  PackageJobSchema,
  type CapabilityObservation,
  type Connector,
  type ImportDefinition,
  type PackageJob,
  type PackageProvenance,
  type Profile,
  type RuntimeJob,
} from '@waleed/contracts';
import type { OperationDialogInput } from './OperationDialog.js';
import type { PackageSeed } from './PackageInstall.js';
import {
  api,
  packageErrorText,
  packageFailureText,
  pollPackageJob,
} from './api.js';
import { compareVersions } from './versions.js';

export type ManagedConnector = Connector & { executionHash: string };
// A managed package is a native connector with a package record.
export type ManagedPackageConnector = Extract<
  ManagedConnector,
  { executionMode: 'native' }
> & { package: PackageProvenance };
export function isManagedPackage(
  connector: ManagedConnector,
): connector is ManagedPackageConnector {
  return connector.executionMode === 'native' && !!connector.package;
}

// The results of the file verification of the hub.
type VerifyResult = 'verified' | 'package_modified' | 'invalid_configuration';
// Session results belong to one revision: a replace bumps the revision, so
// the results of the old package never stick to the new one.
const sessionKey = (connector: ManagedConnector) =>
  `${connector.id}:${connector.revision}`;
// What the managed panel of a package connector always says.
const MANAGED_PANEL =
  "Managed package: the hub's node.exe, the --no-global-search-paths flag and the entry file are fixed by the install; editing can change the name, description, enabled state, the arguments after the entry and the environment.";
const REINSTALL_PANEL =
  'If you moved the Waleed MCP Hub folder, the stored node.exe path no longer exists. Reinstall pins the connector to the current node.exe; approve it again afterwards.';
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
  openPackage,
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
  openPackage: (seed: PackageSeed) => void;
}) {
  const [job, setJob] = useState<RuntimeJob | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  // The last file verification of this session, per connector.
  const [verifications, setVerifications] = useState<
    Record<string, VerifyResult>
  >({});
  // The last update lookup of this session, per connector.
  const [updates, setUpdates] = useState<
    Record<
      string,
      {
        state: 'checking' | 'up_to_date' | 'found' | 'failed';
        version?: string;
      }
    >
  >({});
  const [packageJobs, setPackageJobs] = useState<Record<string, PackageJob>>(
    {},
  );
  // Every running package poll of this view; all of them stop on unmount.
  const aborts = useRef(new Set<AbortController>());
  // Rows stay compact; details open in place and several may be open at once.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(
    () => () => {
      for (const controller of aborts.current) controller.abort();
      aborts.current.clear();
    },
    [],
  );
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
  // The file verification never starts a process and never runs package code.
  async function verifyFiles(connector: ManagedConnector) {
    setError('');
    try {
      const result = await api<{ connectorId: string; result: VerifyResult }>(
        `/api/packages/verify/${connector.id}`,
        {},
      );
      setVerifications((current) => ({
        ...current,
        [sessionKey(connector)]: result.result,
      }));
    } catch (failure) {
      setError(packageFailureText(failure));
    }
  }
  // The update lookup resolves the tree only; it installs nothing.
  async function checkForUpdate(connector: ManagedConnector) {
    const record = isManagedPackage(connector) ? connector.package : null;
    if (!record) return;
    setError('');
    setUpdates((current) => ({
      ...current,
      [sessionKey(connector)]: { state: 'checking' },
    }));
    const controller = new AbortController();
    aborts.current.add(controller);
    try {
      const started = PackageJobSchema.parse(
        await api<PackageJob>('/api/packages/resolve', {
          name: record.name,
        }),
      );
      const final = await pollPackageJob(
        started,
        (next) => {
          setPackageJobs((current) => ({
            ...current,
            [sessionKey(connector)]: next,
          }));
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (final.state === 'succeeded' && final.preview) {
        const version = final.preview.version;
        setUpdates((current) => ({
          ...current,
          [sessionKey(connector)]: {
            // Only a newer release is an update: a lower latest is never
            // offered as a downgrade.
            state:
              compareVersions(version, record.version) > 0
                ? 'found'
                : 'up_to_date',
            version,
          },
        }));
        return;
      }
      setUpdates((current) => ({
        ...current,
        [sessionKey(connector)]: { state: 'failed' },
      }));
      setError(packageErrorText(final.error ?? 'install_failed'));
    } catch (failure) {
      setUpdates((current) => ({
        ...current,
        [sessionKey(connector)]: { state: 'failed' },
      }));
      setError(packageFailureText(failure));
    } finally {
      aborts.current.delete(controller);
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
          // A managed package is a native connector with a package record.
          const record = isManagedPackage(connector) ? connector.package : null;
          const managed = record !== null;
          const target = managed
            ? `npm ${record.name}@${record.version} · ${record.entry}`
            : connector.executionMode === 'native'
              ? [connector.executable, ...connector.arguments].join(' ')
              : connector.executionMode === 'docker'
                ? connector.image
                : connector.endpoint;
          const verification = verifications[sessionKey(connector)];
          const update = updates[sessionKey(connector)];
          const reinstall =
            managed &&
            (verification === 'package_modified' ||
              verification === 'invalid_configuration' ||
              observation?.reason === 'package_modified' ||
              observation?.reason === 'invalid_configuration');
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
                  {managed ? 'npm package' : connector.executionMode}
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
                      managed={managed}
                      reinstall={reinstall}
                      update={update}
                      authenticate={authenticate}
                      operate={operate}
                      openPackage={openPackage}
                      check={(id) => void check(id)}
                      verify={(target) => void verifyFiles(target)}
                      checkUpdate={(target) => void checkForUpdate(target)}
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
                    {managed && record && (
                      <div>
                        <dt>Package</dt>
                        <dd>
                          {record.name}@{record.version} · {record.entry} ·{' '}
                          {record.integrity.slice(0, 16)}…
                        </dd>
                      </div>
                    )}
                    {managed && (
                      <div>
                        <dt>Files</dt>
                        <dd>
                          {verification === 'verified'
                            ? 'verified'
                            : verification === 'package_modified'
                              ? 'modified since install'
                              : verification === 'invalid_configuration'
                                ? 'definition does not match the package record'
                                : 'not verified yet'}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {managed && (
                    <p className="notice">
                      {MANAGED_PANEL}
                      {reinstall ? ` ${REINSTALL_PANEL}` : ''}
                    </p>
                  )}
                  {update?.state === 'checking' &&
                    packageJobs[sessionKey(connector)] && (
                      <p role="status" className="notice">
                        Update lookup:{' '}
                        {packageJobs[sessionKey(connector)]!.phase.replaceAll(
                          '_',
                          ' ',
                        )}{' '}
                        ·{' '}
                        {packageJobs[sessionKey(connector)]!.progress.packages}{' '}
                        packages
                      </p>
                    )}
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
  managed,
  reinstall,
  update,
  authenticate,
  operate,
  openPackage,
  check,
  verify,
  checkUpdate,
}: {
  connector: ManagedConnector;
  approval: boolean;
  secretBacked: boolean;
  disabled: boolean;
  runtime: boolean;
  secrets: boolean;
  checking: boolean;
  managed: boolean;
  reinstall: boolean;
  update:
    | {
        state: 'checking' | 'up_to_date' | 'found' | 'failed';
        version?: string;
      }
    | undefined;
  authenticate: (connector: ManagedConnector) => void;
  operate: (input: OperationDialogInput) => void;
  openPackage: (seed: PackageSeed) => void;
  check: (id: string) => void;
  verify: (connector: ManagedConnector) => void;
  checkUpdate: (connector: ManagedConnector) => void;
}) {
  const managedConnector = isManagedPackage(connector) ? connector : null;
  const record = managedConnector?.package ?? null;
  return (
    <>
      {managed && (
        <button
          disabled={disabled}
          title="Re-checks the installed files. No package code runs."
          onClick={() => verify(connector)}
        >
          Verify files
        </button>
      )}
      {managed &&
        (update?.state === 'found' ? (
          <button
            disabled={disabled || !managedConnector}
            onClick={() => {
              if (!managedConnector) return;
              openPackage({
                mode: 'replace',
                purpose: 'update',
                connector: managedConnector,
                ...(update.version ? { version: update.version } : {}),
              });
            }}
          >
            Update to {update.version}
          </button>
        ) : update?.state === 'up_to_date' ? (
          <button disabled={disabled} onClick={() => checkUpdate(connector)}>
            Up to date · check again
          </button>
        ) : (
          <button
            disabled={disabled || update?.state === 'checking'}
            onClick={() => checkUpdate(connector)}
          >
            {update?.state === 'checking'
              ? 'Checking for update…'
              : 'Check for update'}
          </button>
        ))}
      {managed && reinstall && record && managedConnector && (
        <button
          disabled={disabled}
          onClick={() =>
            openPackage({
              mode: 'replace',
              purpose: 'reinstall',
              connector: managedConnector,
              version: record.version,
            })
          }
        >
          Reinstall
        </button>
      )}
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
            context: managed
              ? { ...editableDefinition(connector), effect: MANAGED_PANEL }
              : editableDefinition(connector),
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
              effect: managed
                ? 'Remove definition and desired memberships, not credentials or provider authorization. Reapply affected profiles. Its install folder is deleted.'
                : 'Remove definition and desired memberships, not credentials or provider authorization. Reapply affected profiles.',
            },
          })
        }
      >
        Remove
      </button>
    </>
  );
}
