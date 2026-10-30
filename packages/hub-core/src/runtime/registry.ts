import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { ConnectorSchema, StateSchema, isPackageEnvName as isRefusedPackageEnvName, type Connector, type HubState, type ImportDefinition, type PackageProvenance, type Profile, type RegistryOperation } from '@waleed/contracts';
import { HubError, RevisionConflictError } from '../errors.js';
import { normalizeImport, clearImport } from '../imports/normalize.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hashData = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const hashBytes = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// The managed package layout is defined here and nowhere else: the store, the
// installer and the registry all build the same entry path from it.
export const NO_GLOBAL_SEARCH_PATHS = '--no-global-search-paths';
// Nothing that starts with NODE_ and none of the OpenSSL certificate
// variables may reach a package connector: they change how the bundled Node
// and npm preload code and trust TLS.
export const isPackageEnvName = (name: string) => isRefusedPackageEnvName(name);
export function packageEntryFile(packagesDir: string, pkg: PackageProvenance): string {
  return win32.join(packagesDir, pkg.installId, 'node_modules', ...pkg.name.split('/'), ...pkg.entryPath.split('/'));
}
export function packageArguments(packagesDir: string, pkg: PackageProvenance, userArgs: readonly string[]): string[] {
  return [NO_GLOBAL_SEARCH_PATHS, packageEntryFile(packagesDir, pkg), ...userArgs];
}
// The inverse of packageEntryFile: the packages folder that owns an entry file.
export function packagesDirOf(entryFile: string, pkg: PackageProvenance): string | null {
  const suffix = win32.join(pkg.installId, 'node_modules', ...pkg.name.split('/'), ...pkg.entryPath.split('/'));
  const marker = `\\${suffix}`;
  if (!entryFile.endsWith(marker)) return null;
  const packagesDir = entryFile.slice(0, entryFile.length - marker.length);
  return packagesDir ? packagesDir : null;
}
export function executionDefinition(connector: Connector) {
  const common = { executionMode: connector.executionMode, transport: connector.transport, environmentLiterals: connector.environmentLiterals ?? {}, secretBindings: connector.secretBindings, headerBindings: connector.headerBindings, ...(connector.credentialFormats && Object.keys(connector.credentialFormats).length ? { credentialFormats: connector.credentialFormats } : {}) };
  // Provenance belongs to the approved definition: any change invalidates it.
  return connector.executionMode === 'native' ? { ...common, executable: connector.executable, arguments: connector.arguments, ...(connector.package ? { package: connector.package } : {}) } : connector.executionMode === 'docker' ? { ...common, image: connector.image, command: connector.command ?? [], arguments: connector.arguments, ...(connector.portBindings?.length ? {portBindings:connector.portBindings}: {}) } : { ...common, endpoint: connector.endpoint };
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
export interface RegistryContext { trustedPackage?: PackageProvenance; nodeExecutable?: string; packagesDir?: string }
// A definition that carries a package record at all: the client may not send it.
const suppliedPackage = (definition: ImportDefinition) => definition.executionMode === 'native' && Object.hasOwn(definition, 'package');
function checkedSource(source: Record<string, unknown>) {
  const draft = normalizeImport(JSON.stringify(source));
  try { if (draft.entries[0]?.issues.length || !draft.entries[0]?.definition) throw new HubError('invalid', 'Connector contains an unsupported executable, argument, literal, or endpoint.'); }
  finally { clearImport(draft); }
}
function checkedReferences(definition: ImportDefinition, state: HubState) {
  for (const id of [...Object.values(definition.secretBindings), ...Object.values(definition.headerBindings)]) if (id.startsWith('draft-') || !state.secretReferences.some((reference) => reference.id === id)) throw new HubError('invalid', 'Use an existing secret-store reference; private import drafts cannot be saved before P6.');
  if (definition.executionMode !== 'remote' && Object.keys(definition.headerBindings).length) throw new HubError('invalid', 'Header references require a remote connector.');
  if (definition.executionMode === 'remote' && (Object.keys(definition.secretBindings).length || Object.keys(definition.environmentLiterals).length)) throw new HubError('invalid', 'Remote definitions cannot contain an environment.');
}
function checkedDefinition(definition: ImportDefinition, state: HubState, context: RegistryContext, stored?: Connector): ImportDefinition {
  const { id, name, description, enabled, environmentLiterals } = definition;
  if (definition.executionMode === 'native' && definition.package) {
    const pkg = definition.package;
    // Only the installer may produce a provenance record, and only for the
    // exact package, runtime and entry file the hub derived itself.
    if (!context.trustedPackage || canonical(context.trustedPackage) !== canonical(pkg)) throw new HubError('invalid', 'Package provenance must come from the installer.');
    if (!context.nodeExecutable || !context.packagesDir) throw new HubError('invalid', 'A package connector runs on the hub runtime.');
    if (definition.executable !== context.nodeExecutable) throw new HubError('invalid', 'A package connector runs on the hub runtime.');
    if (definition.arguments[0] !== NO_GLOBAL_SEARCH_PATHS) throw new HubError('invalid', 'A package connector needs the fixed runtime flag.');
    if (definition.arguments[1] !== packageEntryFile(context.packagesDir, pkg)) throw new HubError('invalid', 'A package connector runs the installed entry file.');
    for (const key of [...Object.keys(environmentLiterals), ...Object.keys(definition.secretBindings)]) if (isPackageEnvName(key)) throw new HubError('invalid', 'Environment names starting with NODE_ and the OpenSSL certificate variables are refused on package connectors.');
    // The user arguments follow the entry script, so they are not interpreter
    // flags: only the credential and literal checks apply to them.
    checkedSource({ id, name, description, enabled, command: 'package-entry', args: definition.arguments.slice(2), environmentLiterals });
  } else {
    if (stored && stored.executionMode === 'native' && stored.package) throw new HubError('invalid', 'A managed connector keeps its package provenance.');
    const source = definition.executionMode === 'remote' ? { id, name, description, enabled, url: definition.endpoint, transport: definition.transport } : definition.executionMode === 'native' ? { id, name, description, enabled, command: definition.executable, args: definition.arguments, environmentLiterals } : { id, name, description, enabled, image: definition.image, command: definition.command, args: definition.arguments, environmentLiterals };
    checkedSource(source);
  }
  checkedReferences(definition, state);
  return structuredClone(definition);
}
// A managed connector keeps its provenance, its runtime and its fixed
// arguments; only the client fields and the user arguments may change.
function managedDefinition(raw: ImportDefinition, existing: Connector, state: HubState): ImportDefinition {
  if (existing.executionMode !== 'native' || !existing.package) throw new HubError('invalid', 'A managed connector keeps its package provenance.');
  const pkg = existing.package;
  if (raw.executionMode !== 'native' || raw.executionMode !== existing.executionMode) throw new HubError('invalid', 'A managed connector keeps its execution mode.');
  if (raw.executable !== existing.executable) throw new HubError('invalid', 'A managed connector keeps its runtime.');
  if (raw.arguments[0] !== existing.arguments[0] || raw.arguments[1] !== existing.arguments[1]) throw new HubError('invalid', 'A managed connector keeps its fixed arguments.');
  const packagesDir = packagesDirOf(existing.arguments[1] ?? '', pkg);
  if (!packagesDir) throw new HubError('invalid', 'A managed connector keeps its installed entry file.');
  const definition: ImportDefinition = { id: existing.id, name: raw.name, description: raw.description, enabled: raw.enabled, environmentLiterals: raw.environmentLiterals, secretBindings: raw.secretBindings, headerBindings: raw.headerBindings, ...(raw.credentialFormats ? { credentialFormats: raw.credentialFormats } : {}), trustApproval: null, executionMode: 'native', transport: existing.transport, executable: existing.executable, package: pkg, arguments: [...existing.arguments.slice(0, 2), ...raw.arguments.slice(2)] };
  return checkedDefinition(definition, state, { trustedPackage: pkg, nodeExecutable: existing.executable, packagesDir }, existing);
}
export interface RegistryPlan { next: HubState; targetId: string; affectedProfiles: string[]; affectedConnectors: string[]; changes: string[]; warnings: string[] }
// The shared tail of every registry mutation: touched profiles, secret
// ownership, agent reconnect flags, the state revision and the state schema.
function finalizeRegistry(next: HubState, profiles: Set<string>, connectors: Set<string>, timestamp: string) {
  for (const profile of next.profiles) if (profile.connectorIds.some((id) => connectors.has(id)) && !profiles.has(profile.id)) { profile.revision++; profile.updatedAt = timestamp; profiles.add(profile.id); }
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
}
export function planRegistry(input: RegistryOperation, state: HubState, targetId: string, timestamp: string, context: RegistryContext = {}): RegistryPlan {
  // The revision moved: nothing was planned and nothing was committed, so the
  // caller may preview again.
  if (input.expectedRevision !== state.revision) throw new RevisionConflictError('Inventory changed. Create a new preview.');
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
        // The stored connector is loaded before anything is validated: a client
        // may never add, replace or remove package provenance.
        const existing = input.kind === 'edit_connector' ? requireConnector(next, input.connectorId) : null;
        if (input.kind !== 'create_connector' && suppliedPackage(raw)) throw new HubError('invalid', 'Package provenance cannot be supplied by a client.');
        if (existing && raw.id !== existing.id) conflict('A connector identifier cannot be changed by editing.');
        const managed = existing && existing.executionMode === 'native' && existing.package ? existing : null;
        const definition = managed ? managedDefinition(raw, managed, next) : checkedDefinition(raw, next, context, existing ?? undefined);
        if (next.connectors.some((item) => item.id !== existing?.id && (item.id === definition.id || fold(item.name) === fold(definition.name)))) conflict('Connector name or identifier already exists.');
        const connector = ConnectorSchema.parse({ ...definition, revision: existing ? existing.revision + 1 : 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
        next.connectors = next.connectors.filter((item) => item.id !== existing?.id); next.connectors.push(connector);
        connectors.add(connector.id); actualTarget = connector.id;
      }
      break;
    }
    case 'set_connector_enabled': {
      const connector = requireConnector(next, input.connectorId); if (connector.enabled === input.enabled) conflict('Connector already has this state.');
      connector.enabled = input.enabled; connector.revision++; connector.updatedAt = timestamp; connector.trustApproval = null; connectors.add(connector.id); actualTarget = connector.id; break;
    }
    case 'remove_connector': {
      requireConnector(next, input.connectorId); next.connectors = next.connectors.filter((item) => item.id !== input.connectorId); connectors.add(input.connectorId); actualTarget = input.connectorId;
      for (const profile of next.profiles) if (profile.connectorIds.includes(input.connectorId)) { profile.connectorIds = profile.connectorIds.filter((id) => id !== input.connectorId); touch(profile); }
      break;
    }
    case 'approve_connector': {
      const connector = requireConnector(next, input.connectorId);
      if (!connector.enabled || connector.revision !== input.expectedConnectorRevision || definitionHash(connector) !== input.definitionHash) conflict('Definition changed or is disabled. Approve a fresh preview.');
      connector.trustApproval = { revision: connector.revision, definitionHash: input.definitionHash, approvedAt: timestamp, risk: connector.executionMode === 'native' ? 'native_execution' : connector.executionMode === 'docker' ? 'image_execution' : 'network' }; actualTarget = connector.id; break;
    }
    case 'materialize_profile': case 'dematerialize_profile': {
      const profile = requireProfile(next, input.profileId); profiles.add(profile.id); actualTarget = profile.id; break;
    }
  }
  finalizeRegistry(next, profiles, connectors, timestamp);
  return { next, targetId: actualTarget, affectedProfiles: [...profiles], affectedConnectors: [...connectors], changes: [input.kind === 'create_profile' ? 'Add one empty profile to the hub registry.' : `Registry operation: ${input.kind.replaceAll('_', ' ')}.`, 'No agent configuration is written. Existing clients may need reconnecting.'], warnings: ['Saving a definition does not execute it. Approval and capability checks are separate actions.', 'Secret values are retained; no credential deletion or OAuth revocation occurs.'] };
}
// The internal replacement of an installed package. Only the install job calls
// it, under the package lock; it never takes the whole-state revision.
export interface PackageReplaceInput { connectorId: string; expectedConnectorRevision: number; package: PackageProvenance; nodeExecutable: string; packagesDir: string }
export function planPackageReplace(state: HubState, input: PackageReplaceInput, timestamp: string): RegistryPlan {
  const next = structuredClone(state); const profiles = new Set<string>(); const connectors = new Set<string>();
  const connector = requireConnector(next, input.connectorId);
  if (connector.executionMode !== 'native' || !connector.package) throw new HubError('invalid', 'This connector is not a managed package.');
  if (connector.revision !== input.expectedConnectorRevision) conflict('Definition changed. Preview the replacement again.');
  connector.package = input.package;
  connector.executable = input.nodeExecutable;
  connector.arguments = packageArguments(input.packagesDir, input.package, connector.arguments.slice(2));
  connector.revision++;
  connector.updatedAt = timestamp;
  connector.trustApproval = null;
  connectors.add(connector.id);
  finalizeRegistry(next, profiles, connectors, timestamp);
  return { next, targetId: connector.id, affectedProfiles: [...profiles], affectedConnectors: [...connectors], changes: ['Replace the installed package of a managed connector.', 'No agent configuration is written. Existing clients may need reconnecting.'], warnings: ['Saving a definition does not execute it. Approval and capability checks are separate actions.', 'Secret values are retained; no credential deletion or OAuth revocation occurs.'] };
}
