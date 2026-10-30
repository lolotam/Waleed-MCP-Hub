import type { Connector, HubState, Materialization } from '@waleed/contracts';
import type { ManagedFiles, FileScope } from '../adapters/managed-files.js';
import type { DockerProfiles } from '../adapters/docker-profile.js';
import { HubError } from '../errors.js';
import { approved, hashBytes, hashData, profileHash, requireProfile } from './registry.js';
import { assertBinding } from '../auth/bindings.js';

export class MaterializationFault extends HubError {
  constructor(readonly restored: boolean) { super('unavailable', 'External apply failed. Recovery status records whether the prior snapshot was restored.'); }
}
interface FileChange { scope: FileScope; name: string; before: string | null; after: string | null }
export interface MaterializationPlan {
  profileId: string; record: Materialization | null; files: FileChange[];
  dockerId: string; beforeDocker: string | null; afterDocker: string | null;
  paths: string[];
}
export interface Materializer {
  plan(state: HubState, profileId: string, remove: boolean, signal: AbortSignal): Promise<MaterializationPlan>;
  apply(plan: MaterializationPlan, signal: AbortSignal): Promise<{ rollback(): Promise<void> }>;
}
export const managedProfileId = (id: string) => `wmh-${hashData(id).slice(0, 24)}`;
function server(connector: Connector) {
  const common = { name: connector.id, type: connector.executionMode === 'remote' ? 'remote' : 'server', image: connector.executionMode === 'docker' ? connector.image : '', remote: connector.executionMode === 'remote' ? { url: connector.endpoint, transport_type: connector.transport === 'sse' ? 'sse' : 'streamable-http' } : {} };
  return connector.executionMode === 'docker' ? { ...common, ...((connector.command?.length || connector.arguments.length) ? { command: [...(connector.command ?? []), ...connector.arguments] } : {}), ...(Object.keys(connector.environmentLiterals ?? {}).length ? { env: Object.entries(connector.environmentLiterals ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value })) } : {}), ...(Object.keys(connector.secretBindings).length ? { secrets: Object.entries(connector.secretBindings).map(([env, name]) => ({ name, env })) } : {}) } : common;
}
export function createMaterializer(options: { files: ManagedFiles; docker?: DockerProfiles; nodeExecutable: string; launcherModuleUrl: string; registryPath: string; now?: () => number }): Materializer {
  const { files, docker } = options;
  const dockerHash = (raw: string | null) => raw === null ? null : hashData(JSON.parse(raw));
  async function assertBefore(plan: MaterializationPlan) {
    for (const file of plan.files) if ((await files.read(file.scope, file.name)) !== file.before) throw new HubError('conflict', 'Managed file changed after preview.');
    if ((plan.beforeDocker !== null || plan.afterDocker !== null) && (!docker || dockerHash(await docker.read(plan.dockerId, AbortSignal.timeout(10_000))) !== dockerHash(plan.beforeDocker))) throw new HubError('conflict', 'Docker profile changed after preview.');
  }
  return {
    async plan(state, profileId, remove, signal) {
      const profile = requireProfile(state, profileId); const prior = state.materializations?.find((record) => record.profileId === profile.id);
      const prefix = managedProfileId(profile.id); const changes = new Map<string, FileChange>();
      for (const entry of prior?.files ?? []) {
        if (!entry.name.startsWith(prefix + '-')) throw new HubError('conflict', 'A profile cannot modify another profile’s managed files.');
        const before = await files.read(entry.scope, entry.name);
        if (before === null || hashBytes(before) !== entry.hash) throw new HubError('conflict', 'A managed file drifted. Do not overwrite external edits.');
        changes.set(`${entry.scope}:${entry.name}`, { ...entry, before, after: null });
      }
      const put = async (scope: FileScope, name: string, after: string) => {
        const existing = changes.get(`${scope}:${name}`);
        if (!existing && await files.read(scope, name) !== null) throw new HubError('conflict', 'An unowned managed filename already exists.');
        changes.set(`${scope}:${name}`, { scope, name, before: existing?.before ?? null, after });
      };
      const selected = remove || profile.enabled === false ? [] : state.connectors.filter((connector) => connector.enabled && profile.connectorIds.includes(connector.id)).sort((a, b) => a.id.localeCompare(b.id));
      for (const connector of selected) {
        if(state.toolOverrides?.some(item=>item.connectorId===connector.id))throw new HubError('unavailable','Tool overrides require the managed agent bridge; direct profile snapshots cannot apply them.');
        if(Object.values(connector.toolPolicies??{}).some(policy=>policy!=='allow'))throw new HubError('unavailable','Restricted tools require the managed agent bridge; direct profile snapshots cannot enforce tool policies.');
        if (connector.executionMode === 'remote' && new URL(connector.endpoint).protocol === 'http:') throw new HubError('unavailable','Local HTTP endpoints must use the managed host bridge, not Docker loopback/profile snapshots.');
        if (connector.executionMode === 'package') throw new HubError('unavailable','Managed packages run through the persistent agent bridge, not direct Docker/profile launchers.');
        if (connector.executionMode === 'docker' && connector.portBindings?.length) throw new HubError('unavailable','Port-published images require the contained agent bridge, not a Docker catalog snapshot.');
        if (!approved(connector)) throw new HubError('conflict', 'Approve every enabled member definition before materializing.');
        if (Object.keys(connector.headerBindings).length) throw new HubError('unavailable', 'Secret-backed remote profile proxies require the verified P7 agent path; no values are written into Docker snapshots.');
        for (const [name, id] of Object.entries(connector.secretBindings)) {
          assertBinding('environment', name, 'raw'); const reference = state.secretReferences.find((reference) => reference.id === id);
          if (!reference?.present || !reference.ownerIds.includes(connector.id) || reference.adapter !== (connector.executionMode === 'docker' ? 'docker' : 'windows')) throw new HubError('unavailable', 'A compatible protected secret reference is required.');
        }
        const name = `${prefix}-${hashData(connector.id).slice(0, 16)}.json`;
        if (connector.executionMode !== 'native') await put('catalog', name, JSON.stringify(server(connector), null, 2) + '\n');
        else {
          if (!/^[a-z]:[\\/]/i.test(connector.executable) || !/\.exe$/i.test(connector.executable)) throw new HubError('unavailable', 'Native materialization requires an absolute local .exe; shell/shim adapters remain pending.');
          const manifest = JSON.stringify({ version: 1, registryPath: options.registryPath, profileId: profile.id, connector }, null, 2) + '\n';
          await put('runtime', name, manifest);
          await put('runtime', name.replace(/\.json$/, '.mjs'), `import { runNativeLauncher } from ${JSON.stringify(options.launcherModuleUrl)};\nawait runNativeLauncher(new URL(${JSON.stringify('./' + name)}, import.meta.url), ${JSON.stringify(hashBytes(manifest))});\n`);
        }
      }
      const nonNative = selected.filter((connector) => connector.executionMode !== 'native');
      const wantDocker = !remove && (nonNative.length > 0 || prior?.dockerProfileId !== null && prior?.dockerProfileId !== undefined);
      let beforeDocker: string | null = null;
      if (wantDocker || prior?.dockerProfileId) {
        if (!docker) throw new HubError('unavailable', 'Docker is unavailable; native-only profiles can still be materialized.');
        beforeDocker = await docker.read(prefix, signal);
        if (prior?.dockerProfileId && prior.dockerProfileId !== prefix || dockerHash(beforeDocker) !== (prior?.dockerHash ?? null)) throw new HubError('conflict', 'Docker snapshot drift or an unowned profile collision requires review.');
      }
      const afterDocker = wantDocker ? JSON.stringify({ version: 1, id: prefix, name: prefix, servers: nonNative.map((connector) => ({ type: connector.executionMode === 'remote' ? 'remote' : 'image', ...(connector.executionMode === 'remote' ? { endpoint: connector.endpoint } : { image: connector.executionMode === 'docker' ? connector.image : '' }), tools: null, snapshot: { server: server(connector) } })) }, null, 2) + '\n' : null;
      const plannedFiles = [...changes.values()];
      const record: Materialization | null = remove ? null : { profileId, profileRevision: profile.revision, configurationHash: profileHash(profile, state), files: plannedFiles.flatMap((file) => file.after === null ? [] : [{ scope: file.scope, name: file.name, hash: hashBytes(file.after) }]), dockerProfileId: afterDocker === null ? null : prefix, dockerHash: dockerHash(afterDocker), appliedAt: new Date((options.now ?? Date.now)()).toISOString(), ...(selected.some((connector) => Object.keys(connector.secretBindings).length) ? { secretReferenceIds: [...new Set(selected.flatMap((connector) => Object.values(connector.secretBindings)))] } : {}) };
      return { profileId, record, files: plannedFiles, dockerId: prefix, beforeDocker, afterDocker, paths: plannedFiles.map((file) => files.path(file.scope, file.name)) };
    },
    async apply(plan, signal) {
      try { await assertBefore(plan); } catch { throw new MaterializationFault(true); }
      const written: FileChange[] = []; let dockerTouched = false;
      const rollback = async () => {
        const cleanup = AbortSignal.timeout(30_000);
        if (dockerTouched) {
          const current = await docker!.read(plan.dockerId, cleanup);
          if (dockerHash(current) !== dockerHash(plan.beforeDocker)) {
            if (dockerHash(current) !== dockerHash(plan.afterDocker)) throw new HubError('conflict', 'Docker changed externally during apply; rollback refused to overwrite it.');
            if (plan.beforeDocker === null) { if (current !== null) await docker!.remove(plan.dockerId, cleanup); }
            else await docker!.import(plan.dockerId, plan.beforeDocker, cleanup);
          }
          if (dockerHash(await docker!.read(plan.dockerId, cleanup)) !== dockerHash(plan.beforeDocker)) throw new HubError('unavailable', 'Docker rollback read-back failed.');
        }
        for (const file of [...written].reverse()) await files.write(file.scope, file.name, file.after === null ? null : hashBytes(file.after), file.before);
        await assertBefore(plan);
      };
      try {
        for (const file of plan.files) {
          if (signal.aborted) throw new HubError('unavailable', 'Materialization cancelled.');
          // Register the attempted write before awaiting: an adapter may commit
          // and then throw. Only exact read-back permits compensation.
          try { await files.write(file.scope, file.name, file.before === null ? null : hashBytes(file.before), file.after); written.push(file); }
          catch (error) { if (await files.read(file.scope, file.name) === file.after) written.push(file); throw error; }
        }
        if (plan.afterDocker !== plan.beforeDocker) {
          if (plan.afterDocker !== null || plan.beforeDocker !== null) {
            if (signal.aborted) throw new HubError('unavailable', 'Materialization cancelled.');
            dockerTouched = true;
            if (plan.afterDocker === null) await docker!.remove(plan.dockerId, signal); else await docker!.import(plan.dockerId, plan.afterDocker, signal);
            if (dockerHash(await docker!.read(plan.dockerId, signal)) !== dockerHash(plan.afterDocker)) throw new HubError('unavailable', 'Docker snapshot read-back differs from the proposed state.');
          }
        }
        for (const file of plan.files) if (await files.read(file.scope, file.name) !== file.after) throw new HubError('conflict', 'Managed read-back changed.');
        return { rollback };
      } catch {
        try { await rollback(); throw new MaterializationFault(true); }
        catch (error) { if (error instanceof MaterializationFault) throw error; throw new MaterializationFault(false); }
      }
    },
  };
}
