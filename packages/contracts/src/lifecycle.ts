import { z } from 'zod';
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
export const ConnectorHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'needs_reauth',
  'untested',
]);
export const ConnectorHealthSchema = z.strictObject({
  connectorId: id,
  revision,
  status: ConnectorHealthStatusSchema,
  reason: z.enum([
    'none',
    'disabled',
    'approval_required',
    'oauth_expired',
    'invalid_oauth',
    'auth_required',
    'refresh_failed',
    'credentials_missing',
    'unreachable',
    'checking',
    'not_checked',
    'dependency_unavailable',
  ]),
  checkedAt: z.iso.datetime().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
});
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>;
export const ConnectorHealthResponseSchema = z.strictObject({
  connectors: z.array(ConnectorHealthSchema).max(256),
  running: z.boolean(),
});
export const HealthRetestRequestSchema = z.strictObject({
  connectorId: id.optional(),
});
export const LifecyclePreferencesSchema = z.strictObject({
  revision,
  backgroundHealthChecks: z.boolean(),
  keepRunningInTray: z.boolean(),
  onboardingCompleted: z.boolean().default(false),
});
export const LifecyclePreferencesUpdateSchema = LifecyclePreferencesSchema.omit(
  { revision: true },
).extend({
  expectedRevision: revision,
  onboardingCompleted: z.boolean().optional(),
});
export const OnboardingStatusSchema = z.strictObject({
  revision,
  onboardingCompleted: z.boolean(),
});
export const OnboardingUpdateSchema = z.strictObject({
  expectedRevision: revision,
  onboardingCompleted: z.boolean(),
});
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;
export type LifecyclePreferences = z.infer<typeof LifecyclePreferencesSchema>;
export const StartupStatusSchema = z.strictObject({
  available: z.boolean(),
  state: z.enum(['enabled', 'disabled', 'conflict', 'unavailable']),
  enabled: z.boolean(),
});
export const StartupUpdateSchema = z.strictObject({
  enabled: z.boolean(),
  expectedState: z.enum(['enabled', 'disabled']),
});
export type StartupStatus = z.infer<typeof StartupStatusSchema>;
