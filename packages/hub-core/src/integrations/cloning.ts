import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import {
  CloneApplySchema,
  CloneSelectionSchema,
  CloneJobSchema,
  type CloneJob,
  type CloneCandidate,
  type CloneApply,
  type PackageJob,
} from '@waleed/contracts';
import { HubError } from '../errors.js';
import { normalizeImport, clearImport } from '../imports/normalize.js';
import { object } from '../discovery/metadata.js';
import { hashData, definitionHash } from '../runtime/registry.js';
import type { IntegrationAdapters } from './engine.js';
import type { PackageService } from '../packages/service.js';
import { agentServers, managedName } from './formats.js';
import { addManualMcp } from './manual.js';

type Host = Parameters<typeof addManualMcp>[0] & {
  packages: PackageService | null;
};
type Source = {
  path: string;
  hash: string;
  name: string;
  format: IntegrationAdapters['targets'][number]['format'];
};
type Record = {
  owner: string;
  view: CloneJob;
  sources: Map<string, Source>;
  controller: AbortController;
  task?: Promise<void>;
  packageJob?: string;
  revoked?: boolean;
};
export interface AgentCloning {
  scan(owner: string): CloneJob;
  job(id: string, owner: string): CloneJob;
  prepare(id: string, keys: unknown, owner: string): CloneJob;
  copy(id: string, raw: unknown, owner: string): CloneJob;
  cancel(id: string, owner: string): CloneJob;
  revoke(owner: string): void;
  close(): Promise<void>;
}
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
const fold = (name: string) => name.trim().normalize('NFKC').toLowerCase();
const busy = (record: Record) =>
  ['queued', 'running'].includes(record.view.state);

// Only exact environment references are interpreted. Source files are data,
// never scripts; file substitutions and shell interpolation stay unsupported.
function canonical(raw: unknown, environment: Readonly<NodeJS.ProcessEnv>) {
  const source = object(raw);
  if (!source) throw new HubError('invalid', 'Unsupported MCP entry.');
  const entry = structuredClone(source);
  const missing: string[] = [];
  const resolve = (value: unknown, name: string): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const reference =
      /^(?:\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}|%([A-Za-z_][A-Za-z0-9_]*)%)$/.exec(
        value,
      );
    if (!reference) {
      if (/\$\{|\{(?:env|file):|%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) {
        missing.push(name);
        return undefined;
      }
      return value;
    }
    const key = reference[1] ?? reference[2] ?? reference[3]!;
    const found = Object.entries(environment).find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    )?.[1];
    if (!found) missing.push(name);
    return found;
  };
  const values = (raw: unknown) => {
    const output: { [key: string]: string } = {};
    const map = object(raw);
    if (raw !== undefined && (!map || Object.keys(map).length > 64))
      throw new HubError('invalid', 'Unsupported credential bindings.');
    for (const [name, value] of Object.entries(map ?? {})) {
      if (
        !/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(name) ||
        typeof value !== 'string'
      )
        throw new HubError('invalid', 'Unsupported credential bindings.');
      const resolved = resolve(value, name);
      if (resolved !== undefined) output[name] = resolved;
    }
    return output;
  };
  const env = values(entry.env ?? entry.environment);
  if (Array.isArray(entry.env_vars) && entry.env_vars.length > 64)
    throw new HubError('invalid', 'Too many environment references.');
  for (const name of Array.isArray(entry.env_vars) ? entry.env_vars : []) {
    if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(name))
      throw new HubError('invalid', 'Unsupported environment reference.');
    const found = resolve(`\${${name}}`, name);
    if (found !== undefined) env[name] = found;
  }
  const remote = object(entry.remote);
  const headers = values(
    entry.headers ?? entry.http_headers ?? remote?.headers,
  );
  if (remote && Object.hasOwn(remote, 'headers')) remote.headers = headers;
  if (typeof entry.bearer_token_env_var === 'string') {
    const value = resolve(`\${${entry.bearer_token_env_var}}`, 'Authorization');
    if (value) headers.Authorization = `Bearer ${value}`;
  }
  delete entry.env_vars;
  delete entry.bearer_token_env_var;
  delete entry.http_headers;
  delete entry.environment;
  if (entry.disabled !== undefined) {
    entry.enabled = entry.disabled === false;
    delete entry.disabled;
  }
  if (entry.type === 'local') {
    delete entry.type;
  }
  if (Object.keys(env).length) entry.env = env;
  else delete entry.env;
  if (Object.keys(headers).length) {
    if (remote) remote.headers = headers;
    else entry.headers = headers;
  } else delete entry.headers;
  return {
    entry,
    env,
    headers,
    missing,
    clear() {
      for (const map of [env, headers])
        for (const key of Object.keys(map)) map[key] = '';
    },
  };
}

export function createAgentCloning(
  host: Host,
  adapters: IntegrationAdapters,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  now = Date.now,
): AgentCloning {
  const records = new Map<string, Record>();
  let closed = false;
  let copying = false;
  const current = (id: string, owner: string) => {
    const record = records.get(id);
    if (
      closed ||
      !record ||
      record.owner !== owner ||
      record.revoked ||
      (!busy(record) && Date.parse(record.view.expiresAt) <= now())
    )
      throw new HubError('not_found', 'Scan expired. Scan your agents again.');
    return record;
  };
  const project = (record: Record) =>
    CloneJobSchema.parse(structuredClone(record.view));
  const run = (
    record: Record,
    phase: CloneJob['phase'],
    action: () => Promise<void>,
  ) => {
    if (busy(record) || record.task)
      throw new HubError('busy', 'This scan already has a running operation.');
    record.controller = new AbortController();
    record.view.state = 'queued';
    record.view.phase = phase;
    record.view.reason = null;
    record.view.expiresAt = new Date(now() + 15 * 60_000).toISOString();
    const timer = setTimeout(() => record.controller.abort(), 10 * 60_000);
    record.task = Promise.resolve().then(async () => {
      record.view.state = 'running';
      try {
        await action();
        record.controller.signal.throwIfAborted();
        record.view.state = 'succeeded';
      } catch (error) {
        record.view.state = record.controller.signal.aborted
          ? 'cancelled'
          : 'failed';
        record.view.reason = record.controller.signal.aborted
          ? 'cancelled'
          : error instanceof HubError && error.message === 'source_changed'
            ? 'source_changed'
            : error instanceof HubError && error.message === 'inventory_changed'
              ? 'inventory_changed'
              : 'unavailable';
      } finally {
        clearTimeout(timer);
        delete record.packageJob;
        delete record.task;
        record.view.phase = 'complete';
      }
    });
    return project(record);
  };
  const packageDone = async (record: Record, job: PackageJob) => {
    record.packageJob = job.id;
    while (['queued', 'running'].includes(job.state)) {
      if (record.controller.signal.aborted) cancelPackage(record);
      await wait();
      job = host.packages!.job(job.id, record.owner);
    }
    delete record.packageJob;
    return job;
  };
  const selected = (record: Record, keys: string[]) =>
    keys.map((key) => {
      const candidate = record.view.candidates.find((item) => item.key === key);
      if (!candidate || candidate.state === 'needs_setup')
        throw new HubError(
          'invalid',
          'Select supported entries from this scan.',
        );
      return candidate;
    });
  const approve = async (id: string, owner: string) => {
    const state = await host.inventory(),
      connector = state.connectors.find((item) => item.id === id)!;
    const preview = await host.preview(
      {
        kind: 'approve_connector',
        expectedRevision: state.revision,
        connectorId: id,
        expectedConnectorRevision: connector.revision,
        definitionHash: definitionHash(connector),
        approveExecution: true,
      },
      owner,
    );
    const job = await host.apply(preview.id, owner);
    while (['queued', 'running'].includes(host.job(job.id, owner).state))
      await wait();
    if (host.job(job.id, owner).state !== 'succeeded')
      throw new HubError('unavailable', 'Approval did not complete.');
  };
  const cancel = (record: Record) => {
    record.controller.abort();
    cancelPackage(record);
  };
  function cancelPackage(record: Record) {
    if (!record.packageJob) return;
    try {
      host.packages?.cancel(record.packageJob, record.owner);
    } catch (error) {
      if (!(error instanceof HubError && error.code === 'busy')) throw error;
    }
  }
  return {
    scan(owner) {
      if (closed)
        throw new HubError('unavailable', 'Agent scanning is closed.');
      for (const [id, record] of records)
        if (
          !busy(record) &&
          (record.owner === owner || Date.parse(record.view.expiresAt) <= now())
        )
          records.delete(id);
      if (
        [...records.values()].some(
          (record) => record.owner === owner && busy(record),
        )
      )
        throw new HubError('busy', 'An agent import is already running.');
      if (records.size >= 20)
        throw new HubError('busy', 'Too many active agent scans.');
      const id = randomUUID();
      const record: Record = {
        owner,
        controller: new AbortController(),
        sources: new Map(),
        view: {
          id,
          state: 'succeeded',
          phase: 'complete',
          expectedRevision: 0,
          expiresAt: new Date(now() + 15 * 60_000).toISOString(),
          reason: null,
          truncated: false,
          agents: [],
          candidates: [],
          results: [],
        },
      };
      records.set(id, record);
      return run(record, 'scanning', async () => {
        const inventory = await host.inventory();
        record.view.expectedRevision = inventory.revision;
        for (const target of adapters.targets) {
          record.controller.signal.throwIfAborted();
          const agent: CloneJob['agents'][number] = {
            agentId: target.id,
            name: target.name,
            detected: false,
            state: 'missing',
          };
          record.view.agents.push(agent);
          if (target.blocked) {
            agent.state = 'blocked';
            continue;
          }
          try {
            const files = [];
            for (const path of target.paths) {
              const text = await adapters.files.read(path);
              if (text !== null) files.push({ path, text });
            }
            agent.detected = files.length > 0;
            if (!files.length) {
              agent.detected =
                (
                  await adapters.discovery.find(
                    target.aliases,
                    AbortSignal.any([
                      record.controller.signal,
                      AbortSignal.timeout(3000),
                    ]),
                  )
                ).length > 0;
              continue;
            }
            if (files.length > 1) {
              agent.state = 'ambiguous';
              continue;
            }
            agent.state = 'found';
            const file = files[0]!,
              servers = agentServers(file.text, target.format);
            for (const [name, raw] of Object.entries(servers)) {
              if (name === managedName) continue;
              const source = object(raw);
              if (
                source &&
                JSON.stringify([source.command, source.args]).includes(
                  adapters.registry,
                )
              )
                continue;
              if (record.view.candidates.length >= 256) {
                record.view.truncated = true;
                break;
              }
              const key = randomUUID();
              let prepared: ReturnType<typeof canonical> | undefined;
              let normalized: ReturnType<typeof normalizeImport> | undefined;
              let candidate: CloneCandidate = {
                key,
                agentId: target.id,
                name: `Unsupported MCP ${record.view.candidates.length + 1}`,
                state: 'needs_setup',
                existing: false,
                enabled: true,
                definition: null,
                packageProposal: null,
                packagePreview: null,
                credentialCount: 0,
                missing: [],
                issues: ['unsupported_entry'],
              };
              try {
                prepared = canonical(raw, environment);
                normalized = normalizeImport(
                  JSON.stringify({ mcpServers: { [name]: prepared.entry } }),
                  Object.values(servers),
                );
                const entry = normalized.entries[0]!;
                candidate = {
                  ...candidate,
                  name: entry.name,
                  enabled:
                    entry.definition?.enabled ??
                    !entry.warnings.includes('disabled_entry'),
                  definition: entry.definition,
                  packageProposal: entry.packageProposal ?? null,
                  credentialCount:
                    Object.keys(prepared.env).length +
                    Object.keys(prepared.headers).length,
                  missing: prepared.missing,
                  issues: entry.issues.map((issue) => issue.code).slice(0, 100),
                  state: entry.definition
                    ? 'ready'
                    : entry.packageProposal
                      ? 'package'
                      : 'needs_setup',
                };
                if (candidate.credentialCount > 16) {
                  candidate.state = 'needs_setup';
                  candidate.issues.push('credential_limit');
                }
                if (
                  candidate.packageProposal &&
                  Object.keys(prepared.env).some(
                    (name) =>
                      !candidate.packageProposal!.envNames.includes(name),
                  )
                ) {
                  candidate.state = 'needs_setup';
                  candidate.issues.push('unsupported_environment');
                }
              } catch {
                /* Unsupported entries stay visible, with no raw source data. */
              } finally {
                if (normalized) clearImport(normalized);
                prepared?.clear();
              }
              candidate.existing = inventory.connectors.some(
                (item) => fold(item.name) === fold(candidate.name),
              );
              record.view.candidates.push(candidate);
              record.sources.set(key, {
                path: file.path,
                hash: hashData(raw),
                name,
                format: target.format,
              });
            }
          } catch {
            agent.state = 'invalid';
          }
        }
      });
    },
    job(id, owner) {
      return project(current(id, owner));
    },
    prepare(id, rawKeys, owner) {
      const record = current(id, owner),
        candidates = selected(record, CloneSelectionSchema.parse(rawKeys));
      return run(record, 'preparing', async () => {
        for (const candidate of candidates) {
          record.controller.signal.throwIfAborted();
          if (!candidate.packageProposal) continue;
          if (!host.packages)
            throw new HubError(
              'unavailable',
              'Package installation is unavailable.',
            );
          const proposal = candidate.packageProposal;
          const job = await packageDone(
            record,
            host.packages.resolve(
              {
                name: proposal.name,
                ...((proposal.version ?? proposal.requestedVersion)
                  ? { version: proposal.version ?? proposal.requestedVersion }
                  : {}),
              },
              owner,
            ),
          );
          if (job.state !== 'succeeded' || !job.preview) {
            candidate.issues = ['package_lookup_failed'];
            continue;
          }
          candidate.packagePreview = job.preview;
          candidate.issues = [];
        }
      });
    },
    copy(id, raw, owner) {
      const input = CloneApplySchema.parse(raw),
        record = current(id, owner);
      const candidates = selected(
        record,
        input.entries.map((entry) => entry.key),
      );
      if (copying)
        throw new HubError('busy', 'Another agent import is running.');
      for (const candidate of candidates)
        if (
          record.view.results.some(
            (item) => item.key === candidate.key && item.connectorId,
          )
        )
          throw new HubError(
            'conflict',
            'This entry was already saved. Repair it in Connectors; do not copy it again.',
          );
      for (const [index, candidate] of candidates.entries())
        if (candidate.packageProposal) {
          const preview = candidate.packagePreview,
            choice = input.entries[index]!;
          if (
            !preview ||
            choice.previewId !== preview.previewId ||
            Date.parse(preview.expiresAt) <= now() ||
            !preview.entries.some((item) => item.entry === choice.entry) ||
            preview.warnings.some(
              (warning) => !choice.acknowledgedWarnings.includes(warning),
            )
          )
            throw new HubError(
              'invalid',
              'Review the resolved package, entry and every warning before copying.',
            );
        }
      copying = true;
      try {
        return run(record, 'copying', async () => {
          try {
            await copy(record, input, candidates);
          } finally {
            copying = false;
          }
        });
      } catch (error) {
        copying = false;
        throw error;
      }
    },
    cancel(id, owner) {
      const record = current(id, owner);
      cancel(record);
      return project(record);
    },
    revoke(owner) {
      for (const record of records.values())
        if (record.owner === owner) {
          record.revoked = true;
          cancel(record);
        }
    },
    async close() {
      closed = true;
      for (const record of records.values()) cancel(record);
      await Promise.allSettled(
        [...records.values()].map((record) => record.task),
      );
      records.clear();
    },
  };

  async function copy(
    record: Record,
    input: CloneApply,
    candidates: CloneCandidate[],
  ) {
    if ((await host.inventory()).revision !== input.expectedRevision)
      throw new HubError('conflict', 'inventory_changed');
    const files = new Map<string, string>();
    // Validate every selected source before the first registry/credential write.
    for (const candidate of candidates) {
      const source = record.sources.get(candidate.key)!;
      let text = files.get(source.path);
      if (text === undefined) {
        const read = await adapters.files.read(source.path);
        if (read === null) throw new HubError('conflict', 'source_changed');
        text = read;
        files.set(source.path, text);
      }
      if (
        hashData(agentServers(text, source.format)[source.name]) !== source.hash
      )
        throw new HubError('conflict', 'source_changed');
    }
    const retried = new Set(input.entries.map((entry) => entry.key));
    record.view.results = record.view.results.filter(
      (result) => result.connectorId !== null || !retried.has(result.key),
    );
    for (const [index, candidate] of candidates.entries()) {
      record.controller.signal.throwIfAborted();
      const source = record.sources.get(candidate.key)!,
        choice = input.entries[index]!;
      let values: ReturnType<typeof canonical> | undefined;
      let connectorId: string | null = null;
      try {
        values = canonical(
          agentServers(files.get(source.path)!, source.format)[source.name],
          environment,
        );
        const state = await host.inventory();
        if (
          state.connectors.some((item) => fold(item.name) === fold(choice.name))
        )
          throw new HubError(
            'conflict',
            'Choose a different destination name.',
          );
        if (candidate.packageProposal) {
          record.controller.signal.throwIfAborted();
          const proposal = candidate.packageProposal;
          const reviewed = candidate.packagePreview!;
          // Bulk imports can evict the installer's bounded preview cache.
          // Resolve just in time, but only install the exact reviewed lock.
          const resolution = await packageDone(
            record,
            host.packages!.resolve(
              { name: reviewed.name, version: reviewed.version },
              record.owner,
            ),
          );
          const fresh = resolution.preview;
          if (resolution.state !== 'succeeded' || !fresh)
            throw new HubError(
              'unavailable',
              'Package review could not be refreshed.',
            );
          const originalEntry = reviewed.entries.find(
            (entry) => entry.entry === choice.entry,
          );
          if (
            fresh.name !== reviewed.name ||
            fresh.version !== reviewed.version ||
            fresh.integrity !== reviewed.integrity ||
            fresh.lockHash !== reviewed.lockHash ||
            !fresh.entries.some(
              (entry) =>
                entry.entry === choice.entry &&
                entry.entryPath === originalEntry?.entryPath,
            ) ||
            fresh.warnings.some(
              (warning) => !choice.acknowledgedWarnings.includes(warning),
            )
          ) {
            candidate.packagePreview = fresh;
            candidate.issues = ['package_changed'];
            throw new HubError(
              'conflict',
              'Package changed. Review the new snapshot before copying.',
            );
          }
          record.controller.signal.throwIfAborted();
          const job = await packageDone(
            record,
            await host.packages!.install(
              {
                previewId: fresh.previewId,
                entry: choice.entry,
                acknowledgedWarnings: choice.acknowledgedWarnings,
                connectorName: choice.name,
                arguments: proposal.arguments,
                env: values.env,
              },
              record.owner,
            ),
          );
          connectorId = job.result?.connectorId ?? null;
          record.controller.signal.throwIfAborted();
          if (job.state !== 'succeeded' || !connectorId)
            throw new HubError('unavailable', 'Package copy did not complete.');
          if (job.result!.outcome === 'partially_saved')
            throw new HubError('unavailable', 'Repair the saved package.');
          {
            const state = await host.inventory();
            const installed = state.connectors.find(
              (item) => item.id === connectorId,
            );
            if (!installed || installed.executionMode !== 'native')
              throw new HubError(
                'unavailable',
                'Installed connector is unavailable.',
              );
            const preview = await host.preview(
              {
                kind: 'edit_connector',
                connectorId,
                expectedRevision: state.revision,
                definition: {
                  id: installed.id,
                  name: installed.name,
                  description:
                    `Imported from ${candidate.agentId}${values.missing.length ? `; missing credentials: ${values.missing.join(', ')}` : ''}`.slice(
                      0,
                      1000,
                    ),
                  enabled: candidate.enabled,
                  environmentLiterals: installed.environmentLiterals ?? {},
                  secretBindings: installed.secretBindings,
                  headerBindings: installed.headerBindings,
                  ...(installed.credentialFormats
                    ? { credentialFormats: installed.credentialFormats }
                    : {}),
                  trustApproval: null,
                  executionMode: 'native',
                  transport: 'stdio',
                  executable: installed.executable,
                  arguments: installed.arguments,
                },
              },
              record.owner,
            );
            const job = await host.apply(preview.id, record.owner);
            while (
              ['queued', 'running'].includes(
                host.job(job.id, record.owner).state,
              )
            )
              await wait();
            if (host.job(job.id, record.owner).state !== 'succeeded')
              throw new HubError(
                'unavailable',
                'Imported settings were not saved.',
              );
          }
          if (candidate.enabled) await approve(connectorId, record.owner);
        } else {
          const definition = candidate.definition!;
          let command =
            definition.executionMode === 'native' ? definition.executable : '';
          if (
            definition.executionMode === 'native' &&
            !/^[a-z]:[\\/]/i.test(command)
          ) {
            const binary = win32.basename(command, win32.extname(command));
            const found = await adapters.discovery.find(
              [binary],
              record.controller.signal,
            );
            command =
              found.find((path) => path.toLowerCase().endsWith('.exe')) ??
              command;
          }
          record.controller.signal.throwIfAborted();
          const result = await addManualMcp(
            host,
            {
              expectedRevision: state.revision,
              name: choice.name,
              enabled: candidate.enabled,
              description:
                `Imported from ${candidate.agentId}${values.missing.length ? `; missing credentials: ${values.missing.join(', ')}` : ''}`.slice(
                  0,
                  1000,
                ),
              type:
                definition.executionMode === 'remote'
                  ? definition.transport
                  : definition.executionMode === 'docker'
                    ? 'docker'
                    : 'stdio',
              command,
              containerCommand:
                definition.executionMode === 'docker' ? definition.command : [],
              args:
                definition.executionMode === 'remote'
                  ? []
                  : definition.arguments,
              image:
                definition.executionMode === 'docker' ? definition.image : '',
              url:
                definition.executionMode === 'remote'
                  ? definition.endpoint
                  : '',
              env: { ...definition.environmentLiterals, ...values.env },
              headers: values.headers,
              ports:
                definition.executionMode === 'docker'
                  ? (definition.portBindings ?? [])
                  : [],
              approveExecution: true,
              autoSync: false,
              confirmSave: true,
            },
            record.owner,
            record.controller.signal,
          );
          connectorId = result.connectorId;
          if (result.state !== 'saved')
            throw new HubError('unavailable', 'Repair the saved connector.');
        }
        record.view.results.push({
          key: candidate.key,
          connectorId,
          state: 'saved',
        });
      } catch {
        record.view.results.push({
          key: candidate.key,
          connectorId,
          state: connectorId ? 'partially_saved' : 'failed',
        });
      } finally {
        values?.clear();
      }
    }
    record.view.expectedRevision = (await host.inventory()).revision;
  }
}
