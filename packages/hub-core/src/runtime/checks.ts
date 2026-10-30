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
  return {
    async observations() {
      const state = await store.read();
      return state.connectors.map((connector) => { const observed = observations.get(connector.id); return observed?.revision === connector.revision && observed.definitionHash === definitionHash(connector) ? structuredClone(observed) : untested(connector); });
    },
    async start(id: string, owner: string, background = false) {
      if (closed || !runtime) throw new HubError('unavailable', 'No verified runtime adapter is configured.');
      if (starting) throw new HubError('busy', 'Another check is being admitted.'); starting = true;
      try {
        await safety.assertWritable(); const state = await store.read(); const connector = structuredClone(requireConnector(state, id));
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
        observations.set(id, observed);
        const timer = setTimeout(() => { job.reason = 'timed_out'; controller.abort(); }, connector.executionMode === 'package' ? 120_000 : 20_000);
        const task = Promise.resolve().then(async () => {
          let result: CapabilityObservation = { ...observed };
          let uncertain = false;
          try {
            const discovered = background ? await runtime.discover(connector, controller.signal, {allowInstall:false}) : await runtime.discover(connector, controller.signal);
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
      } finally { starting = false; }
    },
    job(id: string, owner: string) { const entry = jobs.get(id); if (!entry || entry.owner !== owner) throw new HubError('not_found', 'Check job not found.'); return structuredClone(entry.job); },
    async wait(id: string, owner: string) { const entry = jobs.get(id); if (!entry || entry.owner !== owner) throw new HubError('not_found', 'Check job not found.'); await entry.task; return structuredClone(entry.job); },
    cancel(id: string, owner: string) { const entry = jobs.get(id); if (!entry || entry.owner !== owner) throw new HubError('not_found', 'Check job not found.'); if (!entry.job.completedAt) entry.controller.abort(); return structuredClone(entry.job); },
    invalidate(ids: string[]) { ids.forEach((id) => { observations.delete(id); for (const entry of jobs.values()) if (entry.job.connectorId === id && !entry.job.completedAt) entry.controller.abort(); }); },
    async drain() { await Promise.all([...jobs.values()].map((entry) => entry.task)); },
    async close() { closed = true; for (const entry of jobs.values()) if (!entry.job.completedAt) entry.controller.abort(); await Promise.all([...jobs.values()].map((entry) => entry.task)); },
  };
}
