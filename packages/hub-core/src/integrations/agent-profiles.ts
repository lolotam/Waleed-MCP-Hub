import {
  ToolPolicyNameSchema,
  type HubState,
  type IntegrationAgentId,
  type HttpClientAgentId,
  type CapabilityObservation,
  type AgentToolSet,
} from '@waleed/contracts';
import { approved, definitionHash, hashData } from '../runtime/registry.js';

// Absence alone means unrestricted. A present but unresolved/disabled binding
// must never fall back to All Connectors.
export function assignedAgentProfile(
  state: HubState,
  agentId?: HttpClientAgentId,
) {
  const bindings = state.agentProfileBindings ?? {};
  if (
    !agentId ||
    agentId === 'http-client' ||
    !Object.hasOwn(bindings, agentId)
  )
    return undefined;
  const id = bindings[agentId];
  return { id, profile: state.profiles.find((profile) => profile.id === id) };
}
export function agentCanAccessConnector(
  state: HubState,
  agentId: HttpClientAgentId | undefined,
  connectorId: string,
) {
  const assignment = assignedAgentProfile(state, agentId);
  return (
    !assignment ||
    (!!assignment.profile &&
      assignment.profile.enabled !== false &&
      assignment.profile.connectorIds.includes(connectorId))
  );
}
export function agentToolSearchMode(
  state: HubState,
  agentId?: HttpClientAgentId,
) {
  return (
    !!agentId &&
    agentId !== 'http-client' &&
    Object.hasOwn(state.agentToolSearchModes ?? {}, agentId) &&
    state.agentToolSearchModes?.[agentId] === true
  );
}
export function agentScopeHash(state: HubState, agentId?: HttpClientAgentId) {
  const assignment = assignedAgentProfile(state, agentId),
    profile = assignment?.profile;
  return hashData(
    assignment
      ? {
          agentId,
          profileId: assignment.id,
          profile: profile
            ? {
                id: profile.id,
                revision: profile.revision,
                enabled: profile.enabled !== false,
                connectorIds: profile.connectorIds,
              }
            : null,
        }
      : { agentId, all: true },
  );
}
export function agentToolSet(
  state: HubState,
  agentId: IntegrationAgentId,
  observations: CapabilityObservation[],
): AgentToolSet {
  const assignment = assignedAgentProfile(state, agentId),
    profile = assignment?.profile;
  const eligible = state.connectors.filter(
    (connector) =>
      agentCanAccessConnector(state, agentId, connector.id) &&
      connector.enabled &&
      approved(connector),
  );
  let toolCount = 0,
    unverifiedConnectorCount = 0;
  for (const connector of eligible) {
    const observation = observations.find(
      (item) =>
        item.connectorId === connector.id &&
        item.revision === connector.revision &&
        item.definitionHash === definitionHash(connector) &&
        item.state === 'connected',
    );
    if (!observation) {
      unverifiedConnectorCount++;
      continue;
    }
    toolCount += new Set(
      observation.tools
        .filter(
          (tool) =>
            ToolPolicyNameSchema.safeParse(tool.name).success &&
            (!Object.hasOwn(connector.toolPolicies ?? {}, tool.name) ||
              connector.toolPolicies![tool.name] !== 'block'),
        )
        .map((tool) => tool.name),
    ).size;
  }
  return {
    agentId,
    toolSearchMode: agentToolSearchMode(state, agentId),
    profileId: assignment?.id ?? null,
    profileState: !assignment
      ? 'all'
      : !profile
        ? 'missing'
        : profile.enabled === false
          ? 'disabled'
          : 'enabled',
    connectorCount: eligible.length,
    toolCount: Math.min(
      agentToolSearchMode(state, agentId) ? 4096 : 256,
      toolCount,
    ),
    unverifiedConnectorCount,
  };
}
