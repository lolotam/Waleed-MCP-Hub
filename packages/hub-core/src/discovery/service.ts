import { randomUUID } from 'node:crypto';
import {
  IdSchema,
  AdoptionPreviewSchema,
  type DiscoveryJob,
  type DiscoverySnapshot,
  type HubState,
  type AdoptionPreview,
} from '@waleed/contracts';
import { HubError } from '../errors.js';
import { emptyDiscovery, surveyEnvironment } from './survey.js';
import type { DiscoveryPorts, DiscoverySettings } from './ports.js';

export function createDiscoveryService(
  ports: DiscoveryPorts,
  rawSettings: DiscoverySettings,
  now: () => number = Date.now,
) {
  if (!IdSchema.safeParse(rawSettings.profileId).success)
    throw new HubError('invalid', 'Invalid pilot profile identifier.');
  const settings = structuredClone(rawSettings);
  let snapshot = emptyDiscovery(settings);
  let active: { controller: AbortController; task: Promise<void> } | undefined;
  let lastStarted: number | null = null;
  let closed = false;
  const jobs = new Map<string, { owner: string; job: DiscoveryJob }>();
  return {
    snapshot(): DiscoverySnapshot {
      return structuredClone(snapshot);
    },
    start(owner: string): DiscoveryJob {
      if (closed) throw new HubError('unavailable', 'Discovery is closed.');
      if (active || (lastStarted !== null && now() - lastStarted < 5000))
        throw new HubError(
          'busy',
          'Discovery is running or was recently refreshed.',
        );
      lastStarted = now();
      if (jobs.size >= 20) {
        const first = jobs.keys().next().value;
        if (first) jobs.delete(first);
      }
      const job: DiscoveryJob = {
        id: randomUUID(),
        state: 'queued',
        createdAt: new Date(now()).toISOString(),
        completedAt: null,
        phase: 'queued',
        reason: 'none',
      };
      jobs.set(job.id, { owner, job });
      const controller = new AbortController();
      const timer = setTimeout(() => {
        job.reason = 'deadline';
        controller.abort();
      }, 60_000);
      const task = Promise.resolve().then(async () => {
        job.state = 'running';
        try {
          const next = await surveyEnvironment(
            ports,
            settings,
            controller.signal,
            (phase) => {
              job.phase = phase;
            },
            now,
          );
          if (!controller.signal.aborted) {
            snapshot = next;
            job.state = 'succeeded';
            job.phase = 'complete';
          } else {
            job.state = job.reason === 'deadline' ? 'failed' : 'cancelled';
            if (job.reason === 'none') job.reason = 'cancelled';
          }
        } catch {
          job.state =
            controller.signal.aborted && job.reason !== 'deadline'
              ? 'cancelled'
              : 'failed';
          job.reason = controller.signal.aborted
            ? job.reason === 'deadline'
              ? 'deadline'
              : 'cancelled'
            : 'discovery_failed';
        } finally {
          clearTimeout(timer);
          job.completedAt = new Date(now()).toISOString();
          active = undefined;
        }
      });
      active = { controller, task };
      return structuredClone(job);
    },
    job(id: string, owner: string): DiscoveryJob {
      const entry = jobs.get(id);
      if (!entry || entry.owner !== owner)
        throw new HubError('not_found', 'Discovery job not found.');
      return structuredClone(entry.job);
    },
    cancel(id: string, owner: string): DiscoveryJob {
      const entry = jobs.get(id);
      if (!entry || entry.owner !== owner)
        throw new HubError('not_found', 'Discovery job not found.');
      if (['queued', 'running'].includes(entry.job.state)) {
        entry.job.reason = 'cancelled';
        active?.controller.abort();
      }
      return structuredClone(entry.job);
    },
    preview(state: HubState, recoveryBlocked: boolean): AdoptionPreview {
      const conflicts: AdoptionPreview['conflicts'] = [];
      if (snapshot.pilot.state !== 'observed')
        conflicts.push('snapshot_unavailable');
      if (snapshot.pilot.drift === 'different') conflicts.push('source_drift');
      if (snapshot.pilot.drift === 'unknown')
        conflicts.push('unknown_comparison');
      if (state.connectors.length) conflicts.push('registry_not_empty');
      if (
        snapshot.pilot.candidates.some((candidate) =>
          state.connectors.some(
            (existing) =>
              existing.name.toLowerCase() === candidate.name.toLowerCase(),
          ),
        )
      )
        conflicts.push('candidate_name_conflict');
      if (snapshot.agents.some((agent) => agent.configSummary === 'conflict'))
        conflicts.push('configuration_conflict');
      if (recoveryBlocked) conflicts.push('unresolved_registry_operation');
      if (snapshot.pilot.chrome.isolation === 'personal_attach')
        conflicts.push('unsafe_native_attachment');
      if (
        snapshot.pilot.chrome.launcherObserved &&
        !snapshot.pilot.chrome.recipeRecognized
      )
        conflicts.push('unknown_native_launcher');
      return AdoptionPreviewSchema.parse({
        snapshotId: snapshot.id,
        checkedAt: snapshot.checkedAt,
        expectedRevision: state.revision,
        applySupported: false,
        freshness: 'snapshot_only',
        candidates: snapshot.pilot.candidates,
        conflicts,
        effects: [
          'existing_pilot_unchanged',
          'agents_unchanged',
          'secrets_not_copied',
          'connectors_not_executed',
        ],
      });
    },
    async drain() {
      await active?.task;
    },
    async close() {
      closed = true;
      active?.controller.abort();
      await active?.task;
    },
  };
}
export type DiscoveryService = ReturnType<typeof createDiscoveryService>;
