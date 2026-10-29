import { z } from 'zod';
import { ImportDefinitionSchema } from './imports.js';

export const LifecycleKindSchema = z.enum([
  'integrate_agent',
  'disconnect_agent',
  'sync_agents',
  'check_connector',
  'write_credential',
  'delete_credential',
  'create_profile',
  'edit_profile',
  'remove_profile',
  'set_profile_enabled',
  'assign_connector',
  'unassign_connector',
  'create_connector',
  'create_connectors',
  'edit_connector',
  'remove_connector',
  'set_connector_enabled',
  'approve_connector',
  'materialize_profile',
  'dematerialize_profile',
]);
const Id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Name = z.string().trim().min(1).max(100);
const ids = z
  .array(Id)
  .max(256)
  .refine((items) => new Set(items).size === items.length);
const base = { expectedRevision: Revision };
export const RegistryOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('create_profile'),
    name: Name,
    description: z.string().max(1000),
    connectorIds: ids.optional(),
    enabled: z.boolean().optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('edit_profile'),
    profileId: Id,
    name: Name,
    description: z.string().max(1000),
    connectorIds: ids,
    enabled: z.boolean(),
  }),
  z.strictObject({ ...base, kind: z.literal('remove_profile'), profileId: Id }),
  z.strictObject({
    ...base,
    kind: z.literal('set_profile_enabled'),
    profileId: Id,
    enabled: z.boolean(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('assign_connector'),
    profileId: Id,
    connectorId: Id,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('unassign_connector'),
    profileId: Id,
    connectorId: Id,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('create_connector'),
    definition: ImportDefinitionSchema,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('create_connectors'),
    definitions: z.array(ImportDefinitionSchema).min(1).max(32),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('edit_connector'),
    connectorId: Id,
    definition: ImportDefinitionSchema,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('remove_connector'),
    connectorId: Id,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('set_connector_enabled'),
    connectorId: Id,
    enabled: z.boolean(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('approve_connector'),
    connectorId: Id,
    expectedConnectorRevision: Revision,
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    approveExecution: z.literal(true),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('materialize_profile'),
    profileId: Id,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('dematerialize_profile'),
    profileId: Id,
  }),
]);
export const MaterializationSchema = z.strictObject({
  profileId: Id,
  profileRevision: Revision,
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z
    .array(
      z.strictObject({
        scope: z.enum(['catalog', 'runtime']),
        name: z.string().regex(/^wmh-[a-f0-9-]+\.(?:json|mjs)$/),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(256),
  dockerProfileId: Id.nullable(),
  dockerHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  appliedAt: z.iso.datetime(),
  secretReferenceIds: ids.optional(),
});
export const AgentBindingSchema = z.strictObject({
  agentId: z.enum([
    'opencode',
    'codex',
    'antigravity',
    'grok',
    'claude',
    'kilo',
    'kimi',
    'cursor',
  ]),
  profileId: Id,
  appliedRevision: Revision,
  reconnectRequired: z.boolean(),
});
export const CapabilityObservationSchema = z.strictObject({
  connectorId: Id,
  revision: Revision,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum([
    'untested',
    'checking',
    'connected',
    'auth_required',
    'error',
    'unsupported',
    'unavailable',
    'cancelled',
    'timed_out',
  ]),
  checkedAt: z.iso.datetime().nullable(),
  method: z.enum(['none', 'mcp_discovery']),
  protocolVersion: z.string().max(40).nullable(),
  tools: z
    .array(
      z.strictObject({
        name: z.string().max(100),
        role: z.enum(['upstream', 'gateway_management']),
      }),
    )
    .max(256),
  resourceCount: z.number().int().min(0).max(256),
  promptCount: z.number().int().min(0).max(256),
  reason: z.enum([
    'none',
    'approval_required',
    'disabled',
    'secrets_pending',
    'adapter_pending',
    'auth_required',
    'protocol_error',
    'limit_exceeded',
    'dependency_unavailable',
    'cancelled',
    'timed_out',
    'destination_denied',
    'definition_changed',
    'auth_expired',
    'package_modified',
    'invalid_configuration',
  ]),
});
export const RuntimeJobSchema = z.strictObject({
  id: z.uuid(),
  connectorId: Id,
  revision: Revision,
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  reason: CapabilityObservationSchema.shape.reason,
});
export type RegistryOperation = z.infer<typeof RegistryOperationSchema>;
export type Materialization = z.infer<typeof MaterializationSchema>;
export type CapabilityObservation = z.infer<typeof CapabilityObservationSchema>;
export type RuntimeJob = z.infer<typeof RuntimeJobSchema>;
