import { z } from 'zod';
import { LifecycleKindSchema } from './runtime.js';

export const RefusalReasonSchema = z.enum([
  'host_denied',
  'origin_denied',
  'origin_required',
  'session_required',
  'csrf_required',
  'launch_expired',
  'invalid_input',
  'invalid_request',
  'conflict',
  'unavailable',
  'invalid',
  'not_found',
  'busy',
  'internal_error',
]);
export const AuditRouteSchema = z.enum([
  'agent_scan',
  'agent_integrate',
  'agent_disconnect',
  'agent_status',
  'manual_mcp',
  'agent_sync',
  'desktop_shutdown',
  'health',
  'session',
  'logout',
  'bootstrap',
  'connectors',
  'profiles',
  'agents',
  'activity',
  'settings',
  'preview',
  'apply',
  'job',
  'cancel',
  'security_activity',
  'recovery',
  'discovery',
  'discovery_job',
  'discovery_cancel',
  'adoption_preview',
  'import_preview',
  'import_read',
  'import_selection',
  'import_cancel',
  'import_save_preview',
  'connector_check',
  'runtime_job',
  'runtime_cancel',
  'credential_write',
  'credential_delete',
  'auth_status',
  'oauth_start',
  'oauth_refresh',
  'auth_job',
  'auth_cancel',
  'package_resolve',
  'package_install',
  'package_job',
  'package_cancel',
  'package_verify',
  'assets',
  'unknown',
]);
export const RefusalInputSchema = z.strictObject({
  reason: RefusalReasonSchema,
  route: AuditRouteSchema,
  method: z.enum(['GET', 'HEAD', 'POST', 'OTHER']),
  status: z.number().int().min(400).max(599),
});
export const SecurityEventSchema = RefusalInputSchema.extend({
  id: z.uuid(),
  time: z.iso.datetime(),
});
export const JournalEntrySchema = z.strictObject({
  id: z.uuid(),
  operation: LifecycleKindSchema,
  targetId: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['prepared', 'committed', 'aborted', 'needs_review']),
  reason: z.enum([
    'none',
    'commit_failed',
    'interrupted_before_commit',
    'interrupted_after_commit',
    'state_drift',
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  external: z.boolean().optional(),
});
export const SafetyStateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    securityEvents: z.array(SecurityEventSchema).max(200),
    operations: z.array(JournalEntrySchema).max(100),
  })
  .superRefine((state, ctx) => {
    for (const entries of [state.securityEvents, state.operations]) {
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate safety record identifiers.',
        });
    }
    for (const entry of state.operations) {
      const allowed = {
        prepared: ['none'],
        committed: ['none', 'interrupted_after_commit'],
        aborted: ['commit_failed', 'interrupted_before_commit'],
        needs_review: ['state_drift'],
      };
      if (
        entry.beforeHash === entry.afterHash ||
        !allowed[entry.phase].includes(entry.reason)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid journal state transition metadata.',
        });
    }
  });
export type RefusalInput = z.infer<typeof RefusalInputSchema>;
export type SecurityEvent = z.infer<typeof SecurityEventSchema>;
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type SafetyState = z.infer<typeof SafetyStateSchema>;
