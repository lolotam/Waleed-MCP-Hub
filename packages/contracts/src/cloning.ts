import { z } from 'zod';
import { IntegrationAgentIdSchema } from './integrations.js';
import { ImportDefinitionSchema } from './imports.js';
import {
  PackagePreviewSchema,
  PackageProposalSchema,
  PackageWarningSchema,
} from './packages.js';

export const CloneCandidateSchema = z.strictObject({
  key: z.uuid(),
  agentId: IntegrationAgentIdSchema,
  name: z.string().min(1).max(100),
  state: z.enum(['ready', 'package', 'needs_setup']),
  existing: z.boolean(),
  enabled: z.boolean(),
  definition: ImportDefinitionSchema.nullable(),
  packageProposal: PackageProposalSchema.nullable(),
  packagePreview: PackagePreviewSchema.nullable(),
  credentialCount: z.number().int().min(0).max(128),
  missing: z.array(z.string().max(100)).max(128),
  issues: z.array(z.string().max(100)).max(100),
});
export const CloneSelectionSchema = z
  .array(z.uuid())
  .min(1)
  .max(256)
  .refine((keys) => new Set(keys).size === keys.length);
export const ClonePrepareSchema = z.strictObject({
  keys: CloneSelectionSchema,
});
export const CloneApplySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  copyCredentials: z.literal(true),
  approveExecution: z.literal(true),
  entries: z
    .array(
      z.strictObject({
        key: z.uuid(),
        name: z.string().trim().min(1).max(100),
        entry: z.string().min(1).max(100).optional(),
        acknowledgedWarnings: z.array(PackageWarningSchema).max(16).default([]),
      }),
    )
    .min(1)
    .max(256)
    .refine(
      (entries) =>
        new Set(entries.map((item) => item.key)).size === entries.length,
    ),
});
export const CloneJobSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  phase: z.enum(['scanning', 'preparing', 'copying', 'complete']),
  expectedRevision: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
  reason: z
    .enum(['source_changed', 'inventory_changed', 'unavailable', 'cancelled'])
    .nullable(),
  truncated: z.boolean(),
  agents: z
    .array(
      z.strictObject({
        agentId: IntegrationAgentIdSchema,
        name: z.string().max(100),
        detected: z.boolean(),
        state: z.enum(['found', 'missing', 'invalid', 'ambiguous', 'blocked']),
      }),
    )
    .max(10),
  candidates: z.array(CloneCandidateSchema).max(256),
  results: z
    .array(
      z.strictObject({
        key: z.uuid(),
        connectorId: z.string().max(80).nullable(),
        state: z.enum(['saved', 'partially_saved', 'failed']),
      }),
    )
    .max(256),
});
export type CloneCandidate = z.infer<typeof CloneCandidateSchema>;
export type CloneJob = z.infer<typeof CloneJobSchema>;
export type CloneApply = z.infer<typeof CloneApplySchema>;
