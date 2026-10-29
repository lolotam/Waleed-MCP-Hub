import { z } from 'zod';

const Id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CredentialWriteSchema = z.strictObject({
  expectedRevision: Revision,
  expectedConnectorRevision: Revision,
  location: z.enum(['environment', 'header']),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
  format: z.enum(['raw', 'bearer', 'basic']),
  adapter: z.enum(['windows', 'docker']),
  value: z.string().min(1).max(8192),
});
export const CredentialReceiptSchema = z.strictObject({
  id: Id,
  present: z.literal(true),
  connectorId: Id,
  revision: Revision,
  requiresApproval: z.boolean(),
});
export const SecretDeleteSchema = z.strictObject({
  expectedRevision: Revision,
  confirmLocalDeletion: z.literal(true),
});
export const OAuthStartSchema = z.strictObject({
  expectedRevision: Revision,
  expectedConnectorRevision: Revision,
  recipeId: Id,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  approveSignInAndDiscovery: z.literal(true),
});
export const AuthReasonSchema = z.enum([
  'none',
  'unsupported',
  'denied',
  'timed_out',
  'cancelled',
  'state_mismatch',
  'invalid_response',
  'dependency_unavailable',
  'definition_changed',
  'refresh_failed',
  'expired',
  'auth_required',
  'recovery_required',
]);
export const AuthJobSchema = z.strictObject({
  id: z.uuid(),
  connectorId: Id,
  recipeId: Id,
  state: z.enum([
    'starting',
    'awaiting_user',
    'saving',
    'checking',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  reason: AuthReasonSchema,
  authorizationUrl: z.string().max(4096).nullable(),
  scopes: z.array(z.string().max(100)).max(16),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type CredentialWrite = z.infer<typeof CredentialWriteSchema>;
export type AuthJob = z.infer<typeof AuthJobSchema>;
export type AuthReason = z.infer<typeof AuthReasonSchema>;
