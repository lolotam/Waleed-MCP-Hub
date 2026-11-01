import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentChangeSchema,
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

export interface IntegrationAdapters {
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
  let scanning = false;
  const requireAdapters = () => {
    if (!adapters)
      throw new HubError(
        'unavailable',
        'Windows agent integration is unavailable.',
      );
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
      result.fingerprint = chosen.text === null ? null : hashBytes(chosen.text);
      const [executable] = await options.discovery.find(
        target.aliases,
        AbortSignal.timeout(5000),
      );
      result.executable = executable ?? null;
      result.detected = !!executable || existing.length > 0;
      if (executable && target.packageName) {
        const manifest = await options.discovery.read(
          win32.join(
            win32.dirname(executable),
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
              record.configPath === chosen.path &&
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
      if ((text === null ? null : hashBytes(text)) !== current.fingerprint)
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
            // Agents rewrite their own configuration at any time (Claude Code
            // does so every few minutes), so the hub's edit is judged by the
            // managed entry alone: an unrelated rewrite racing the replace
            // left nothing of the hub's in the file. An unparseable file
            // fails closed.
            const managed = (value: string | null) =>
              hashData(managedEntry(value, target.format) ?? null);
            unchanged =
              managed(await options.files.read(current.configPath)) ===
                managed(text) && actual === stateHash(before);
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
        )!;
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
