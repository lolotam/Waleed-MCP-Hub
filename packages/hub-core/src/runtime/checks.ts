import { randomUUID } from 'node:crypto';
import type { CapabilityObservation, Connector, RuntimeJob } from '@waleed/contracts';
import type { StateStore } from '../state.js';
import type { SafetyLedger } from '../safety.js';
import { stateHash } from '../safety.js';
import { HubError } from '../errors.js';
import { approved, definitionHash, hashData, requireConnector } from './registry.js';
import { RuntimeFault, type CapabilityRuntime } from './capabilities.js';

function untested(connector: Connector): CapabilityObservation {
  return { connectorId: connector.id, revision: connector.revision, definitionHash: definitionHash(connector), state: 'untested', checkedAt: null, method: 'none', protocolVersion: null, tools: [], resourceCount: 0, promptCount: 0, reason: !connector.enabled ? 'disabled' : !approved(connector) ? 'approval_required' : 'none' };
}
export function createRuntimeChecks(store: StateStore, safety: SafetyLedger, runtime?: CapabilityRuntime, now: () => number = Date.now, secretSupport = false) {
  const observations = new Map<string, CapabilityObservation>();
  const jobs = new Map<string, { owner: string; job: RuntimeJob; controller: AbortController; task: Promise<void> }>();
  let closed = false, starting = false;
  let automatic: Promise<void> | undefined;
  let admission: Promise<void> | undefined;
  const checks = {
    async observations() {
      const state = await store.read();
      return state.connectors.map((connector) => { const observed = observations.get(connector.id); return observed?.revision === connector.revision && observed.definitionHash === definitionHash(connector) ? structuredClone(observed) : untested(connector); });
    },
    async start(id: string, owner: string) {
      if (closed || !runtime) throw new HubError('unavailable', 'No verified runtime adapter is configured.');
      if (starting) throw new HubError('busy', 'Another check is being admitted.'); starting = true;
      let admitted!: () => void;
      admission = new Promise<void>((resolve) => { admitted = resolve; });
      try {
        await safety.assertWritable(); const state = await store.read(); const connector = structuredClone(requireConnector(state, id));
        if (closed) throw new HubError('unavailable', 'Runtime checks are closed.');
        if (!connector.enabled || !approved(connector)) throw new HubError('conflict', 'Approve the current enabled definition before starting it.');
        if (!secretSupport && (Object.keys(connector.secretBindings).length || Object.keys(connector.headerBindings).length)) throw new HubError('unavailable', 'A protected secret backend is required.');
        const active = [...jobs.values()].filter((entry) => !entry.job.completedAt);
        if (active.length >= 2 || active.some((entry) => entry.job.connectorId === id)) throw new HubError('busy', 'Check concurrency limit reached.');
        if (jobs.size >= 100) { const oldest = [...jobs.values()].find((entry) => entry.job.completedAt); if (oldest) jobs.delete(oldest.job.id); }
        const job: RuntimeJob = { id: randomUUID(), connectorId: id, revision: connector.revision, state: 'running', createdAt: new Date(now()).toISOString(), completedAt: null, reason: 'none' };
        const controller = new AbortController();
        const observed = { ...untested(connector), state: 'checking' as const };
        let prepared = false;
        if (connector.executionMode === 'docker') {
          await safety.prepare({ id: job.id, operation: 'check_connector', targetId: id, expectedRevision: state.revision, beforeHash: stateHash(state), afterHash: hashData({ jobId: job.id, cleanup: 'owned_container_label' }), phase: 'prepared', reason: 'none', createdAt: job.createdAt, updatedAt: job.createdAt, external: true }); prepared = true;
        }
        if (closed) controller.abort();
        observations.set(id, observed);
        const timer = setTimeout(() => { job.reason = 'timed_out'; controller.abort(); }, 20_000);
        const task = Promise.resolve().then(async () => {
          let result: CapabilityObservation = { ...observed };
          let uncertain = false;
          try {
            controller.signal.throwIfAborted();
            const discovered = await runtime.discover(connector, controller.signal);
            if (controller.signal.aborted) throw new RuntimeFault(job.reason === 'timed_out' ? 'timed_out' : 'cancelled');
            result = { ...untested(connector), ...discovered, state: 'connected', checkedAt: new Date(now()).toISOString(), method: 'mcp_discovery', reason: 'none' }; job.state = 'succeeded';
          } catch (error) {
            const reason = job.reason === 'timed_out' ? 'timed_out' : controller.signal.aborted ? 'cancelled' : error instanceof RuntimeFault ? error.reason : 'protocol_error';
            uncertain = error instanceof RuntimeFault && error.uncertain;
            job.reason = reason; job.state = reason === 'cancelled' ? 'cancelled' : 'failed';
            result = { ...untested(connector), checkedAt: new Date(now()).toISOString(), method: 'mcp_discovery', state: reason === 'auth_required' ? 'auth_required' : reason === 'adapter_pending' ? 'unsupported' : reason === 'timed_out' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'error', reason };
          } finally {
            clearTimeout(timer);
            if (prepared) {
              try { await safety.finish(job.id, uncertain ? 'needs_review' : job.state === 'succeeded' ? 'committed' : 'aborted', uncertain ? 'state_drift' : job.state === 'succeeded' ? 'none' : 'commit_failed'); }
              catch { job.state = 'failed'; job.reason = 'dependency_unavailable'; }
            }
            const current = (await store.read().catch(() => null))?.connectors.find((item) => item.id === id);
            if (current?.revision === connector.revision && definitionHash(current) === definitionHash(connector)) observations.set(id, result);
            else { observations.delete(id); job.state = 'cancelled'; job.reason = 'definition_changed'; }
            job.completedAt = new Date(now()).toISOString();
          }
        });
        jobs.set(job.id, { job, owner, controller, task }); return structuredClone(job);
      } finally { starting = false; admitted(); admission = undefined; }
    },
    async discoverApproved(owner: string): Promise<void> {
      if (closed || !runtime) throw new HubError('unavailable', 'No verified runtime adapter is configured.');
      await safety.assertWritable();
      if (automatic || closed) return;
      // Reuse the same admission, deadlines, cleanup and two-job limit as a
      // manual check. Re-read desired state between jobs so edits and revocation
      // win over queued work. A failed check is not retried on every UI poll.
      automatic = (async () => {
        while (!closed) {
          const state = await store.read();
          const candidates = state.connectors.filter((connector) => {
            if (!connector.enabled || !approved(connector)) return false;
            const observed = observations.get(connector.id);
            return !observed || observed.revision !== connector.revision || observed.definitionHash !== definitionHash(connector);
          });
          let retryAdmission = false;
          for (const connector of candidates) {
            if (closed || [...jobs.values()].filter((entry) => !entry.job.completedAt).length >= 2) break;
            if (!secretSupport && (Object.keys(connector.secretBindings).length || Object.keys(connector.headerBindings).length)) {
              observations.set(connector.id, { ...untested(connector), state: 'unsupported', reason: 'secrets_pending' });
              continue;
            }
            const inFlight = [...jobs.values()].filter((entry) => !entry.job.completedAt);
            try { await checks.start(connector.id, owner); }
            catch (error) {
              // A Docker discovery owns a prepared safety operation until its
              // cleanup finishes. Wait for active checks before admitting more;
              // an unrelated recovery block with no active checks still pauses.
              if (error instanceof HubError && (error.code === 'busy' || error.code === 'conflict') && inFlight.length) {
                await Promise.race(inFlight.map((entry) => entry.task));
                retryAdmission = true;
                break;
              }
              throw error;
            }
          }
          if (retryAdmission) continue;
          const running = [...jobs.values()].filter((entry) => !entry.job.completedAt);
          if (!running.length) break;
          await Promise.race(running.map((entry) => entry.task));
        }
      })().catch(() => { /* Recovery or shutdown pauses automatic discovery. */ }).finally(() => { automatic = undefined; });
    },
    discovering() { return !!automatic || [...jobs.values()].some((entry) => !entry.job.completedAt); },
    job(id: string, owner: string) { const entry = jobs.get(id); if (!entry || entry.owner !== owner) throw new HubError('not_found', 'Check job not found.'); return structuredClone(entry.job); },
    cancel(id: string, owner: string) { const entry = jobs.get(id); if (!entry || entry.owner !== owner) throw new HubError('not_found', 'Check job not found.'); if (!entry.job.completedAt) entry.controller.abort(); return structuredClone(entry.job); },
    invalidate(ids: string[]) { ids.forEach((id) => { observations.delete(id); for (const entry of jobs.values()) if (entry.job.connectorId === id && !entry.job.completedAt) entry.controller.abort(); }); },
    async drain() { await Promise.all([...jobs.values()].map((entry) => entry.task)); },
    async close() { closed = true; await admission; for (const entry of jobs.values()) if (!entry.job.completedAt) entry.controller.abort(); await Promise.all([...jobs.values()].map((entry) => entry.task)); await automatic; },
  };
  return checks;
}
