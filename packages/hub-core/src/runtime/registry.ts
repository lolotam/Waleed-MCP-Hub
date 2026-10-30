import { createHash } from 'node:crypto';
import { ConnectorSchema, StateSchema, type Connector, type HubState, type ImportDefinition, type Profile, type RegistryOperation } from '@waleed/contracts';
import { HubError } from '../errors.js';
import { normalizeImport, clearImport } from '../imports/normalize.js';
import { assertToolOverrideCollisions } from '../integrations/tool-overrides.js';
import type { CapabilityObservation } from '@waleed/contracts';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hashData = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const hashBytes = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function executionDefinition(connector: Connector) {
  const common = { executionMode: connector.executionMode, transport: connector.transport, environmentLiterals: connector.environmentLiterals ?? {}, secretBindings: connector.secretBindings, headerBindings: connector.headerBindings, ...(connector.credentialFormats && Object.keys(connector.credentialFormats).length ? { credentialFormats: connector.credentialFormats } : {}) };
  return connector.executionMode === 'package' ? {...common, package:connector.package, arguments:connector.arguments} : connector.executionMode === 'native' ? { ...common, executable: connector.executable, arguments: connector.arguments, ...(connector.bundle?{bundle:connector.bundle}:{}) } : connector.executionMode === 'docker' ? { ...common, image: connector.image, command: connector.command ?? [], arguments: connector.arguments, ...(connector.portBindings?.length ? {portBindings:connector.portBindings}: {}) } : { ...common, endpoint: connector.endpoint, ...(connector.localHttpOptIn!==undefined?{localHttpOptIn:connector.localHttpOptIn}:{}) };
}
export const definitionHash = (connector: Connector) => hashData(executionDefinition(connector));
export function approved(connector: Connector) {
  return connector.trustApproval?.revision === connector.revision && connector.trustApproval.definitionHash === definitionHash(connector);
}
export function profileHash(profile: Profile, state: HubState) {
  return hashData({ profile: { id: profile.id, name: profile.name, description: profile.description, enabled: profile.enabled !== false, connectorIds: profile.connectorIds, revision: profile.revision }, connectors: profile.connectorIds.map((id) => state.connectors.find((connector) => connector.id === id)) });
}
const fold = (value: string) => value.trim().normalize('NFKC').toLowerCase();
const conflict = (message: string): never => { throw new HubError('conflict', message); };
export function requireConnector(state: HubState, id: string) {
  const result = state.connectors.find((connector) => connector.id === id);
  if (!result) throw new HubError('not_found', 'Connector not found.'); return result;
}
export function requireProfile(state: HubState, id: string) {
  const result = state.profiles.find((profile) => profile.id === id);
  if (!result) throw new HubError('not_found', 'Profile not found.'); return result;
}
function checkedDefinition(definition: ImportDefinition, state: HubState): ImportDefinition {
  const { id, name, description, enabled, environmentLiterals } = definition;
  const source = definition.executionMode === 'package' ? {id,name,description,enabled,package:definition.package,args:definition.arguments,environmentLiterals} : definition.executionMode === 'remote' ? { id, name, description, enabled, url: definition.endpoint, transport: definition.transport, ...(definition.localHttpOptIn!==undefined?{localHttpOptIn:definition.localHttpOptIn}:{}) } : definition.executionMode === 'native' ? { id, name, description, enabled, command: definition.executable, args: definition.arguments, environmentLiterals } : { id, name, description, enabled, image: definition.image, command: definition.command, args: definition.arguments, environmentLiterals };
  const draft = normalizeImport(JSON.stringify(source));
  try { if (draft.entries[0]?.issues.length || !draft.entries[0]?.definition) throw new HubError('invalid', 'Connector contains an unsupported executable, argument, literal, or endpoint.'); }
  finally { clearImport(draft); }
  for (const id of [...Object.values(definition.secretBindings), ...Object.values(definition.headerBindings)]) if (id.startsWith('draft-') || !state.secretReferences.some((reference) => reference.id === id)) throw new HubError('invalid', 'Use an existing secret-store reference; private import drafts cannot be saved before P6.');
  if (definition.executionMode !== 'remote' && Object.keys(definition.headerBindings).length) throw new HubError('invalid', 'Header references require a remote connector.');
  if (definition.executionMode === 'remote' && (Object.keys(definition.secretBindings).length || Object.keys(definition.environmentLiterals).length)) throw new HubError('invalid', 'Remote definitions cannot contain an environment.');
  return structuredClone(definition);
}
export interface RegistryPlan { next: HubState; targetId: string; affectedProfiles: string[]; affectedConnectors: string[]; changes: string[]; warnings: string[] }
export function planRegistry(input: RegistryOperation, state: HubState, targetId: string, timestamp: string, observations:CapabilityObservation[]=[]): RegistryPlan {
  if (input.expectedRevision !== state.revision) conflict('Inventory changed. Create a new preview.');
  const next = structuredClone(state); const profiles = new Set<string>(); const connectors = new Set<string>();
  const touch = (profile: Profile) => { profile.revision++; profile.updatedAt = timestamp; profiles.add(profile.id); };
  const uniqueProfile = (name: string, except?: string) => { if (next.profiles.some((profile) => profile.id !== except && fold(profile.name) === fold(name))) conflict('A profile with this name already exists.'); };
  const membership = (ids: string[]) => { ids.forEach((id) => requireConnector(next, id)); };
  let actualTarget = targetId;
  switch (input.kind) {
    case 'create_profile': {
      if (next.profiles.length >= 256) throw new HubError('invalid', 'Profile limit reached.');
      uniqueProfile(input.name); membership(input.connectorIds ?? []);
      next.profiles.push({ id: targetId, name: input.name, description: input.description, connectorIds: input.connectorIds ?? [], revision: 1, dockerProfileId: null, updatedAt: timestamp, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) }); profiles.add(targetId); break;
    }
    case 'edit_profile': {
      const profile = requireProfile(next, input.profileId); uniqueProfile(input.name, profile.id); membership(input.connectorIds);
      Object.assign(profile, { name: input.name, description: input.description, connectorIds: input.connectorIds, enabled: input.enabled }); touch(profile); actualTarget = profile.id; break;
    }
    case 'set_profile_enabled': {
      const profile = requireProfile(next, input.profileId); if ((profile.enabled !== false) === input.enabled) conflict('Profile already has this state.'); profile.enabled = input.enabled; touch(profile); actualTarget = profile.id; break;
    }
    case 'remove_profile': {
      const profile = requireProfile(next, input.profileId);
      if(Object.values(next.agentProfileBindings??{}).includes(profile.id))conflict('Reassign agents or select All Connectors before removing this assigned profile.');
      if (next.materializations?.some((record) => record.profileId === profile.id)) conflict('Dematerialize this profile before removing its registry definition.');
      next.profiles = next.profiles.filter((item) => item.id !== profile.id); profiles.add(profile.id); actualTarget = profile.id; break;
    }
    case 'assign_connector': case 'unassign_connector': {
      const profile = requireProfile(next, input.profileId); requireConnector(next, input.connectorId);
      const assigned = profile.connectorIds.includes(input.connectorId);
      if (assigned === (input.kind === 'assign_connector')) conflict('Membership already has this state.');
      profile.connectorIds = input.kind === 'assign_connector' ? [...profile.connectorIds, input.connectorId] : profile.connectorIds.filter((id) => id !== input.connectorId);
      touch(profile); actualTarget = profile.id; break;
    }
    case 'create_connector': case 'create_connectors': case 'edit_connector': {
      const definitions = input.kind === 'create_connectors' ? input.definitions : [input.definition];
      if (input.kind !== 'edit_connector' && next.connectors.length + definitions.length > 256) throw new HubError('invalid', 'Connector limit reached.');
      for (const raw of definitions) {
        const definition = checkedDefinition(raw, next);
        const existing = input.kind === 'edit_connector' ? requireConnector(next, input.connectorId) : null;
        if (existing && definition.id !== existing.id) conflict('A connector identifier cannot be changed by editing.');
        if (next.connectors.some((item) => item.id !== existing?.id && (item.id === definition.id || fold(item.name) === fold(definition.name)))) conflict('Connector name or identifier already exists.');
        const connector = ConnectorSchema.parse({ ...definition, ...(existing?.toolPolicies?{toolPolicies:existing.toolPolicies}:{}), revision: existing ? existing.revision + 1 : 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
        next.connectors = next.connectors.filter((item) => item.id !== existing?.id); next.connectors.push(connector);
        connectors.add(connector.id); actualTarget = connector.id;
      }
      break;
    }
    case 'set_connector_enabled': {
      const connector = requireConnector(next, input.connectorId); if (connector.enabled === input.enabled) conflict('Connector already has this state.');
      connector.enabled = input.enabled; connector.revision++; connector.updatedAt = timestamp; connector.trustApproval = null; connectors.add(connector.id); actualTarget = connector.id; break;
    }
    case 'set_tool_policies': {
      const connector=requireConnector(next,input.connectorId);
      if(connector.revision!==input.expectedConnectorRevision)conflict('Connector changed. Refresh permissions before saving.');
      if(Object.values(input.toolPolicies).some(policy=>policy!=='allow')&&next.materializations?.some(record=>record.files.some(file=>file.name.endsWith(`-${hashData(connector.id).slice(0,16)}.json`))||next.profiles.some(profile=>profile.id===record.profileId&&profile.connectorIds.includes(connector.id))))conflict('Dematerialize direct profile snapshots before restricting tools. Tool policies require the managed agent bridge.');
      if(hashData(connector.toolPolicies??{})===hashData(input.toolPolicies))conflict('Tool policies already have this state.');
      connector.toolPolicies=structuredClone(input.toolPolicies);connector.updatedAt=timestamp;actualTarget=connector.id;
      // Policies authorize bridge calls, not process startup. Keep the execution
      // revision/hash/approval and discovery observations for the unchanged code.
      // The bridge separately fingerprints policies and rechecks every call.
      break;
    }
    case 'set_agent_profile': {
      const current=next.agentProfileBindings?.[input.agentId]??null;
      if(current===input.profileId)conflict('Agent already has this tool set.');
      if(input.profileId!==null)requireProfile(next,input.profileId);
      const bindings={...next.agentProfileBindings};if(input.profileId===null)delete bindings[input.agentId];else bindings[input.agentId]=input.profileId;
      next.agentProfileBindings=bindings;actualTarget=input.agentId;break;
    }
    case 'set_tool_override': {
      const connector=requireConnector(next,input.connectorId);
      if(connector.revision!==input.expectedConnectorRevision)conflict('Connector changed. Refresh tools before saving overrides.');
      if(input.override&&(input.override.connectorId!==connector.id||input.override.originalToolName!==input.originalToolName))conflict('Tool override identity does not match the selected tool.');
      if(input.override&&next.materializations?.some(record=>record.files.some(file=>file.name.endsWith(`-${hashData(connector.id).slice(0,16)}.json`))||next.profiles.some(profile=>profile.id===record.profileId&&profile.connectorIds.includes(connector.id))))conflict('Dematerialize direct profile snapshots before customizing tools. Overrides require the managed bridge.');
      const previous=next.toolOverrides??[],remaining=previous.filter(item=>item.connectorId!==connector.id||item.originalToolName!==input.originalToolName);
      if(hashData(previous.find(item=>item.connectorId===connector.id&&item.originalToolName===input.originalToolName)??null)===hashData(input.override))conflict('Tool override already has this state.');
      const overrides=input.override?[...remaining,structuredClone(input.override)]:remaining;
      if(hashData(previous)===hashData(overrides))conflict('Tool override already has this state.');
      next.toolOverrides=overrides;assertToolOverrideCollisions(next,observations);connector.updatedAt=timestamp;actualTarget=connector.id;break;
    }
    case 'set_agent_tool_search': {
      if((next.agentToolSearchModes?.[input.agentId]===true)===input.toolSearchMode)conflict('Agent already has this tool search mode.');
      const modes={...next.agentToolSearchModes};if(input.toolSearchMode)modes[input.agentId]=true;else delete modes[input.agentId];
      next.agentToolSearchModes=modes;actualTarget=input.agentId;break;
    }
    case 'remove_connector': {
      if(next.toolOverrides)next.toolOverrides=next.toolOverrides.filter(item=>item.connectorId!==input.connectorId);
      requireConnector(next, input.connectorId); next.connectors = next.connectors.filter((item) => item.id !== input.connectorId); connectors.add(input.connectorId); actualTarget = input.connectorId;
      for (const profile of next.profiles) if (profile.connectorIds.includes(input.connectorId)) { profile.connectorIds = profile.connectorIds.filter((id) => id !== input.connectorId); touch(profile); }
      break;
    }
    case 'approve_connector': {
      const connector = requireConnector(next, input.connectorId);
      if (!connector.enabled || connector.revision !== input.expectedConnectorRevision || definitionHash(connector) !== input.definitionHash) conflict('Definition changed or is disabled. Approve a fresh preview.');
      connector.trustApproval = { revision: connector.revision, definitionHash: input.definitionHash, approvedAt: timestamp, risk: connector.executionMode === 'native' || connector.executionMode === 'package' ? 'native_execution' : connector.executionMode === 'docker' ? 'image_execution' : 'network' }; actualTarget = connector.id; break;
    }
    case 'materialize_profile': case 'dematerialize_profile': {
      const profile = requireProfile(next, input.profileId); profiles.add(profile.id); actualTarget = profile.id; break;
    }
  }
  for (const profile of next.profiles) if (profile.connectorIds.some((id) => connectors.has(id)) && !profiles.has(profile.id)) touch(profile);
  for (const reference of next.secretReferences) {
    // Removing a connector only updates ownership metadata. NEVER delete stored
    // values, including unowned values; credential deletion is a separate P6 action.
    const owners = new Set(reference.ownerIds.filter((id) => !connectors.has(id)));
    for (const connector of next.connectors) if (connectors.has(connector.id) && [...Object.values(connector.secretBindings), ...Object.values(connector.headerBindings)].includes(reference.id)) owners.add(connector.id);
    reference.ownerIds = [...owners];
  }
  for (const binding of next.agentBindings ?? []) if (profiles.has(binding.profileId)) binding.reconnectRequired = true;
  next.revision++;
  StateSchema.parse(next);
  return { next, targetId: actualTarget, affectedProfiles: [...profiles], affectedConnectors: [...connectors], changes: [input.kind === 'create_profile' ? 'Add one empty profile to the hub registry.' : `Registry operation: ${input.kind.replaceAll('_', ' ')}.`, 'No agent configuration is written. Existing clients may need reconnecting.'], warnings: ['Saving a definition does not execute it. Approval and capability checks are separate actions.', 'Secret values are retained; no credential deletion or OAuth revocation occurs.'] };
}
