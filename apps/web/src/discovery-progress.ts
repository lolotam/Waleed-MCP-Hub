import type { CapabilityObservation } from '@waleed/contracts';
import type { ManagedConnector } from './ConnectorList.js';

// The states that end a discovery attempt with a failure the user must see.
const failureStates = new Set<CapabilityObservation['state']>([
  'error',
  'timed_out',
  'auth_required',
  'unsupported',
  'unavailable',
  'cancelled',
]);

// The state of the automatic tool discovery of the eligible connectors.
export type DiscoveryProgressState = {
  // The connectors the automatic discovery may check.
  eligible: number;
  // The eligible connectors whose discovery reached a final state.
  settled: number;
  // Whether the discovery is still running.
  loading: boolean;
  // The settled connectors that ended in a failure state.
  needsAttention: number;
  // The tools of the settled, connected connectors.
  tools: number;
  // The settled share of the eligible connectors, rounded down.
  percent: number;
};

// The approval rule: the trust approval must belong to the current revision
// and definition hash of the connector.
export function isApproved(connector: ManagedConnector): boolean {
  return (
    connector.trustApproval?.revision === connector.revision &&
    connector.trustApproval.definitionHash === connector.executionHash
  );
}

// The rule of the automatic discovery: the connector is enabled and approved
// for exactly its current revision and definition hash.
export function isDiscoveryEligible(connector: ManagedConnector): boolean {
  return connector.enabled && isApproved(connector);
}

// The observation of the current revision and definition hash of a connector.
// An observation of an older revision says nothing about the current one.
export function currentObservation(
  connector: ManagedConnector,
  observations: CapabilityObservation[],
): CapabilityObservation | undefined {
  return observations.find(
    (entry) =>
      entry.connectorId === connector.id &&
      entry.revision === connector.revision &&
      entry.definitionHash === connector.executionHash,
  );
}

// The observation of an eligible connector that reached a final state. A
// connector without an observation, or with one that is still running, has no
// settled observation yet.
export function settledObservation(
  connector: ManagedConnector,
  observations: CapabilityObservation[],
): CapabilityObservation | undefined {
  const observation = currentObservation(connector, observations);
  if (!observation) return undefined;
  if (observation.state === 'untested' || observation.state === 'checking')
    return undefined;
  return observation;
}

// How far the automatic tool discovery of the eligible connectors has come.
// Only the observations of the current revision and definition hash count:
// an observation of an older revision belongs to a definition that is gone.
export function discoveryProgress(
  connectors: ManagedConnector[],
  observations: CapabilityObservation[],
): DiscoveryProgressState {
  let eligible = 0;
  let settled = 0;
  let needsAttention = 0;
  let tools = 0;
  for (const connector of connectors) {
    if (!isDiscoveryEligible(connector)) continue;
    eligible += 1;
    const observation = settledObservation(connector, observations);
    if (!observation) continue;
    settled += 1;
    if (observation.state === 'connected') tools += observation.tools.length;
    if (failureStates.has(observation.state)) needsAttention += 1;
  }
  return {
    eligible,
    settled,
    loading: settled < eligible,
    needsAttention,
    tools,
    percent: eligible === 0 ? 0 : Math.floor((settled * 100) / eligible),
  };
}
