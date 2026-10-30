import { randomUUID } from 'node:crypto';
import {
  platformPath,
  platformPathKey,
  type HubPlatform,
} from '../platform/paths.js';
import { fileURLToPath } from 'node:url';
import {
  AgentChangeSchema,
  IntegrationAgentIdSchema,
  AgentToolSetsSchema,
  type CapabilityObservation,
  StateSchema,
  type AgentIntegration,
  type IntegrationAgentId,
} from '@waleed/contracts';
import type { StateStore } from '../state.js';
import { stateHash, type SafetyLedger } from '../safety.js';
import type { MutationLock } from '../auth/credentials.js';
import type { DiscoveryPorts } from '../discovery/ports.js';
import { HubError } from '../errors.js';
import { hashData, hashBytes } from '../runtime/registry.js';
import { agentEntry, editAgentDocument, managedEntry } from './formats.js';
import type { AgentTarget } from './targets.js';
import type { AgentFiles } from './files.js';
import { agentToolSet } from './agent-profiles.js';
const scopeFingerprint = (path: string, text: string, platform: HubPlatform) =>
  hashData([platformPathKey(path, platform), hashBytes(text)]);

export interface IntegrationAdapters {
  platform?: HubPlatform;
  targets: AgentTarget[];
  files: AgentFiles;
  discovery: DiscoveryPorts;
  node: string;
  registry: string;
  bridge?: string;
}
export function createIntegrationEngine(
  store: StateStore,
  safety: SafetyLedger,
  lock: MutationLock,
  adapters?: IntegrationAdapters,
) {
  const observed = new Map<IntegrationAgentId, AgentIntegration>();
  const platform = adapters?.platform ?? 'win32',
    p = platformPath(platform);
  let scanning = false;
  const requireAdapters = () => {
    if (!adapters)
      throw new HubError('unavailable', 'Agent integration is unavailable.');
    return adapters;
  };
  async function inspect(target: AgentTarget): Promise<AgentIntegration> {
    const options = requireAdapters();
    const state = await store.read();
    const result: AgentIntegration = {
      agentId: target.id,
      name: target.name,
      detected: false,
      executable: null,
      configPath: target.paths[0]!,
      version: null,
      status: 'unknown',
      reason: 'unsafe_config',
      fingerprint: null,
      reconnect: target.reconnect,
      verification: 'configuration_only',
    };
    if (target.blocked) {
      result.reason = 'ambiguous_scope';
      return result;
    }
    try {
      const paths = await Promise.all(
        target.paths.map(async (path) => ({
          path,
          text: await options.files.read(path),
        })),
      );
      const existing = paths.filter((item) => item.text !== null);
      if (existing.length > 1) {
        result.reason = 'ambiguous_scope';
        return result;
      }
      const chosen = existing[0] ?? paths[0]!;
      result.configPath = chosen.path;
      result.fingerprint =
        chosen.text === null
          ? null
          : scopeFingerprint(chosen.path, chosen.text, platform);
      const [executable] = await options.discovery.find(
        target.aliases,
        AbortSignal.timeout(5000),
      );
      result.executable = executable ?? null;
      result.detected = !!executable || existing.length > 0;
      if (target.requireExisting && !existing.length) {
        result.reason =
          target.id === 'jetbrains' ? 'ambiguous_scope' : 'not_installed';
        return result;
      }
      if (executable && target.packageName) {
        const manifest = await options.discovery.read(
          p.join(
            p.dirname(executable),
            'node_modules',
            target.packageName,
            'package.json',
          ),
          AbortSignal.timeout(3000),
        );
        if (manifest.status === 'read') {
          const parsed = JSON.parse(manifest.text) as {
            name?: unknown;
            version?: unknown;
          };
          if (
            parsed.name === target.packageName &&
            typeof parsed.version === 'string' &&
            /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(parsed.version)
          )
            result.version = parsed.version;
        }
      }
      const entry = managedEntry(chosen.text, target.format);
      const record = state.integrations?.find(
        (item) => item.agentId === target.id,
      );
      if (
        (target.id === 'kimi' || target.id === 'kilo') &&
        !result.version &&
        !existing.length
      ) {
        result.reason = 'ambiguous_scope';
        return result;
      }
      result.status =
        entry === undefined
          ? 'not_integrated'
          : record &&
              platformPathKey(record.configPath, platform) ===
                platformPathKey(chosen.path, platform) &&
              record.entryHash === hashData(entry)
            ? 'integrated'
            : 'unknown';
      result.reason =
        result.status === 'unknown'
          ? 'conflict'
          : result.detected
            ? 'none'
            : 'not_installed';
    } catch {
      /* Never return parser errors, source config or provider data. */
    }
    return result;
  }
  async function scan() {
    const options = requireAdapters();
    if (scanning) throw new HubError('busy', 'An agent scan is running.');
    scanning = true;
    try {
      const agents: AgentIntegration[] = [];
      for (const target of options.targets) {
        const item = await inspect(target);
        observed.set(target.id, item);
        agents.push(item);
      }
      return { agents };
    } finally {
      scanning = false;
    }
  }
  async function change(id: IntegrationAgentId, raw: unknown, remove: boolean) {
    const input = AgentChangeSchema.parse(raw),
      options = requireAdapters();
    if (!observed.has(id))
      throw new HubError(
        'conflict',
        'Scan agents before changing a configuration.',
      );
    const target = options.targets.find((item) => item.id === id);
    if (!target) throw new HubError('not_found', 'Agent target unavailable.');
    return lock(async () => {
      await safety.assertWritable();
      const before = await store.read();
      if (before.revision !== input.expectedRevision)
        throw new HubError(
          'conflict',
          'Registry changed. Refresh before integration.',
        );
      const current = await inspect(target);
      if (
        current.status === 'unknown' ||
        current.reason !== 'none' ||
        current.fingerprint !== input.fingerprint
      )
        throw new HubError(
          'conflict',
          'Agent scan is stale, unsupported, conflicted or not installed.',
        );
      if (
        (remove &&
          current.status === 'not_integrated' &&
          !before.integrations?.some((item) => item.agentId === id)) ||
        (!remove && current.status === 'integrated')
      )
        return { agent: current, backup: null, changed: false };
      const text = await options.files.read(current.configPath);
      if (
        (text === null
          ? null
          : scopeFingerprint(current.configPath, text, platform)) !==
        current.fingerprint
      )
        throw new HubError('conflict', 'Agent configuration changed.');
      const record = before.integrations?.find((item) => item.agentId === id);
      const entry = agentEntry(
        target.format,
        options.node,
        options.bridge ??
          fileURLToPath(new URL('./bridge.js', import.meta.url)),
        options.registry,
        id,
      );
      const after =
        remove && current.status === 'not_integrated'
          ? text
          : editAgentDocument(
              text,
              target.format,
              remove ? undefined : entry,
              record?.entryHash,
            );
      const next = structuredClone(before);
      next.integrations = (next.integrations ?? []).filter(
        (item) => item.agentId !== id,
      );
      if (!remove)
        next.integrations.push({
          agentId: id,
          configPath: current.configPath,
          entryHash: hashData(managedEntry(after, target.format)),
          syncedRevision: before.revision + 1,
          updatedAt: new Date().toISOString(),
        });
      next.revision++;
      next.activity.push({
        id: randomUUID(),
        time: new Date().toISOString(),
        operation: remove ? 'disconnect_agent' : 'integrate_agent',
        targetId: id,
        priorRevision: before.revision,
        newRevision: next.revision,
        result: 'succeeded',
      });
      next.activity = next.activity.slice(-200);
      StateSchema.parse(next);
      const operation = remove ? 'disconnect_agent' : 'integrate_agent';
      const job = randomUUID();
      const timestamp = new Date().toISOString();
      await safety.prepare({
        id: job,
        operation,
        targetId: id,
        expectedRevision: before.revision,
        beforeHash: stateHash(before),
        afterHash: stateHash(next),
        phase: 'prepared',
        reason: 'none',
        createdAt: timestamp,
        updatedAt: timestamp,
        external: true,
      });
      let backup: string | null = null;
      try {
        if (text !== null && after !== text)
          backup = await options.files.backup(id, text);
        if (after !== null && after !== text)
          await options.files.replace(current.configPath, text, after);
        await store.write(before.revision, next);
      } catch {
        const actual = stateHash(await store.read());
        if (actual !== stateHash(next)) {
          let unchanged = false;
          try {
            unchanged =
              (await options.files.read(current.configPath)) === text &&
              actual === stateHash(before);
          } catch {
            /* fail closed */
          }
          await safety
            .finish(
              job,
              unchanged ? 'aborted' : 'needs_review',
              unchanged ? 'commit_failed' : 'state_drift',
            )
            .catch(() => undefined);
          throw new HubError(
            'unavailable',
            'Agent change failed. Inspect recovery; private backup retained.',
          );
        }
      }
      await safety.finish(job, 'committed').catch(() => undefined);
      const agent = await inspect(target);
      observed.set(id, agent);
      return { agent, backup, changed: true };
    });
  }
  return {
    async toolSets(observations: CapabilityObservation[] = []) {
      const state = await store.read();
      return AgentToolSetsSchema.parse({
        revision: state.revision,
        toolSets: IntegrationAgentIdSchema.options.map((agentId) =>
          agentToolSet(state, agentId, observations),
        ),
      });
    },
    enabled: !!adapters,
    scan,
    async status(id: IntegrationAgentId) {
      const target = requireAdapters().targets.find((item) => item.id === id);
      if (!target) throw new HubError('not_found', 'Agent unavailable.');
      return inspect(target);
    },
    integrate: (id: IntegrationAgentId, raw: unknown) => change(id, raw, false),
    disconnect: (id: IntegrationAgentId, raw: unknown) => change(id, raw, true),
    async sync() {
      // Dynamic bridge entries already reference current registry state. Verify
      // ownership; do not rewrite unchanged files or overwrite external changes.
      const records = (await store.read()).integrations ?? [];
      const results = [];
      if (records.length) requireAdapters();
      for (const record of records) {
        const target = adapters!.targets.find(
          (item) => item.id === record.agentId,
        );
        if (!target) {
          results.push({
            agentId: record.agentId,
            status: 'conflict',
            reconnect:
              'Agent target unavailable in this runtime. No configuration was changed.',
          });
          continue;
        }
        const item = await inspect(target);
        results.push({
          agentId: record.agentId,
          status: item.status === 'integrated' ? 'synced' : 'conflict',
          reconnect: item.reconnect,
        });
      }
      return { agents: results, liveAgentVerification: false };
    },
  };
}
export type IntegrationEngine = ReturnType<typeof createIntegrationEngine>;
