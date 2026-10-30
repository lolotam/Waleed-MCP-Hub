import { z } from 'zod';
import { SecretAdapterSchema } from './platform.js';
export * from './platform.js';
import {
  IntegrationRecordSchema,
  PortBindingsSchema,
  ToolPoliciesSchema,
  IntegrationAgentIdSchema,
  AgentToolSearchModesSchema,
} from './integrations.js';
import { PackageSpecSchema } from './packages.js';
import { McpbBundleSchema } from './mcpb.js';
import { ToolOverridesCollectionSchema } from './tool-overrides.js';
export * from './mcpb.js';
import { EndpointSchema, isLocalHttpEndpoint } from './endpoints.js';
import {
  LifecycleKindSchema,
  MaterializationSchema,
  AgentBindingSchema,
} from './runtime.js';
export * from './safety.js';
export * from './imports.js';
export * from './runtime.js';
export * from './auth.js';
export * from './integrations.js';
export * from './packages.js';
export * from './registry.js';
export * from './endpoints.js';
export * from './smart-paste.js';
export * from './tool-search.js';
export * from './playground.js';
export * from './bridge-content.js';
export * from './lifecycle.js';
export * from './tool-overrides.js';
export * from './setup.js';
export * from './http-transport.js';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const IdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const Timestamp = z.iso.datetime();
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Name = z.string().trim().min(1).max(100);
const Description = z.string().max(1000);
const boundedIds = z
  .array(IdSchema)
  .max(256)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate identifiers');
export const AgentProfileBindingsSchema = z.preprocess(
  (value, ctx) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, '__proto__'))
      ctx.addIssue({ code: 'custom', message: 'Forbidden agent binding key.' });
    return value;
  },
  z
    .partialRecord(IntegrationAgentIdSchema, IdSchema)
    .refine((bindings) => Object.keys(bindings).length <= 24),
);

export const SecretReferenceSchema = z.strictObject({
  id: IdSchema,
  adapter: SecretAdapterSchema,
  present: z.boolean(),
  ownerIds: boundedIds,
  kind: z.enum(['credential', 'oauth']).optional(),
  recipeId: IdSchema.optional(),
});
const BindingName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/);
const SecretBindings = z
  .record(BindingName, IdSchema)
  .refine((bindings) => Object.keys(bindings).length <= 64);
const connectorFields = {
  toolPolicies: ToolPoliciesSchema.optional(),
  id: IdSchema,
  name: Name,
  description: Description,
  enabled: z.boolean(),
  revision: Revision,
  secretBindings: SecretBindings,
  headerBindings: SecretBindings,
  environmentLiterals: z.record(z.string(), z.string()).optional(),
  credentialFormats: z
    .record(BindingName, z.enum(['raw', 'bearer', 'basic']))
    .optional(),
  trustApproval: z
    .strictObject({
      revision: Revision,
      approvedAt: Timestamp,
      risk: z.enum(['network', 'native_execution', 'image_execution']),
      definitionHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
};
const Arguments = z
  .array(
    z
      .string()
      .max(4096)
      .refine((arg) => !arg.includes('\0')),
  )
  .max(128);
export const ConnectorSchema = z.discriminatedUnion('executionMode', [
  z.strictObject({
    ...connectorFields,
    executionMode: z.literal('package'),
    transport: z.literal('stdio'),
    package: PackageSpecSchema,
    arguments: Arguments,
  }),
  z
    .strictObject({
      ...connectorFields,
      executionMode: z.literal('remote'),
      transport: z.enum(['streamable_http', 'sse']),
      endpoint: EndpointSchema,
      localHttpOptIn: z.boolean().optional(),
    })
    .superRefine((value, ctx) => {
      if (isLocalHttpEndpoint(value.endpoint) && value.localHttpOptIn !== true)
        ctx.addIssue({
          code: 'custom',
          path: ['localHttpOptIn'],
          message: 'Explicit local HTTP opt-in is required.',
        });
    }),
  z.strictObject({
    ...connectorFields,
    executionMode: z.literal('native'),
    transport: z.literal('stdio'),
    executable: z
      .string()
      .min(1)
      .max(1024)
      .refine((s) => !/[\r\n\0]/.test(s)),
    arguments: Arguments,
    bundle: McpbBundleSchema.optional(),
  }),
  z.strictObject({
    ...connectorFields,
    executionMode: z.literal('docker'),
    portBindings: PortBindingsSchema.optional(),
    transport: z.literal('stdio'),
    image: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/),
    command: Arguments.optional(),
    arguments: Arguments,
  }),
]);

export const ProfileSchema = z.strictObject({
  id: IdSchema,
  name: Name,
  description: Description,
  connectorIds: boundedIds,
  revision: Revision,
  dockerProfileId: IdSchema.nullable(),
  enabled: z.boolean().optional(),
  updatedAt: Timestamp,
});
export const HealthSchema = z.strictObject({
  connectorId: IdSchema,
  revision: Revision,
  state: z.enum([
    'untested',
    'checking',
    'connected',
    'auth_required',
    'error',
    'unsupported',
    'unavailable',
  ]),
  checkedAt: Timestamp.nullable(),
  method: z.enum(['none', 'mcp_discovery']),
  toolCount: z.number().int().nonnegative().nullable(),
  explanation: z.string().max(1000),
});
export const AgentIdSchema = z.enum([
  'opencode',
  'codex',
  'antigravity',
  'grok',
  'claude',
  'kilo',
  'kimi',
  'cursor',
]);
export const AgentObservationSchema = z.strictObject({
  agentId: AgentIdSchema,
  executable: z.string().max(1024).nullable(),
  version: z.string().max(100).nullable(),
  detected: z.boolean().nullable(),
  compatibility: z.enum(['pending', 'verified', 'unsupported']),
  registered: z.boolean().nullable(),
  reconnectRequired: z.boolean().nullable(),
  checkedAt: Timestamp.nullable(),
});
export const FileObservationSchema = z.strictObject({
  path: z.string().max(2048),
  status: z.enum([
    'read',
    'missing',
    'invalid',
    'inaccessible',
    'unsupported',
    'too_large',
    'unsafe',
  ]),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  hubEntries: z.array(z.enum(['gateway', 'chrome'])).max(2),
  binding: z.enum(['matching', 'conflict', 'absent', 'unknown']),
  entryCount: z.number().int().min(0).max(256).nullable(),
});
export const DiscoveredAgentSchema = AgentObservationSchema.extend({
  aliases: z.array(z.string().max(40)).max(3),
  resolution: z.enum(['exe', 'shim', 'missing', 'error', 'not_checked']),
  versionSource: z.enum(['manifest', 'command', 'unknown']),
  configFiles: z.array(FileObservationSchema).max(8),
  configSummary: z.enum([
    'matching',
    'partial',
    'conflict',
    'absent',
    'pending',
    'error',
  ]),
  scope: z.literal('user_files_only'),
  verification: z.literal('not_performed'),
});
export const AdoptionCandidateSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(100),
  executionMode: z.enum(['remote', 'docker', 'native']),
  origin: z.string().max(300).nullable(),
  secretBindingCount: z.number().int().min(0).max(256),
  verification: z.literal('not_performed'),
});
export const DiscoverySnapshotSchema = z
  .strictObject({
    mode: z.enum(['live', 'fixture']),
    id: z.uuid().nullable(),
    checkedAt: Timestamp.nullable(),
    node: z.strictObject({
      version: z.string().max(40),
      platform: z.string().max(40),
      supported: z.boolean(),
    }),
    docker: z.strictObject({
      executable: z.string().max(2048).nullable(),
      cliVersion: z.string().max(60).nullable(),
      gatewayVersion: z.string().max(60).nullable(),
      engineVersion: z.string().max(60).nullable(),
      state: z.enum([
        'not_checked',
        'missing',
        'available',
        'unavailable',
        'unsupported',
        'error',
      ]),
      reason: z.enum([
        'none',
        'docker_missing',
        'remote_context_not_allowed',
        'engine_unavailable',
        'gateway_unavailable',
        'unsupported_gateway',
        'invalid_output',
        'probe_failed',
      ]),
    }),
    agents: z.array(DiscoveredAgentSchema).length(8),
    pilot: z.strictObject({
      profileId: IdSchema,
      state: z.enum([
        'not_checked',
        'observed',
        'missing',
        'unavailable',
        'invalid',
        'unsupported',
      ]),
      fingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      sourceStatus: z.enum([
        'not_checked',
        'read',
        'missing',
        'invalid',
        'inaccessible',
        'too_large',
        'unsafe',
      ]),
      sourceFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      drift: z.enum(['matching', 'different', 'unknown']),
      unmatchedSourceCount: z.number().int().nonnegative().max(256),
      candidates: z.array(AdoptionCandidateSchema).max(64),
      chrome: z.strictObject({
        launcherObserved: z.boolean(),
        recipeRecognized: z.boolean(),
        isolation: z.enum(['isolated', 'personal_attach', 'unknown']),
        packagePinned: z.boolean(),
      }),
    }),
  })
  .superRefine((snapshot, ctx) => {
    if (new Set(snapshot.agents.map((agent) => agent.agentId)).size !== 8)
      ctx.addIssue({
        code: 'custom',
        message: 'Discovery must contain one observation per agent.',
      });
  });
export const DiscoveryJobSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
  phase: z.enum([
    'queued',
    'executables',
    'configuration',
    'docker',
    'pilot',
    'complete',
  ]),
  reason: z.enum(['none', 'cancelled', 'deadline', 'discovery_failed']),
});
export const AdoptionPreviewSchema = z.strictObject({
  snapshotId: z.uuid().nullable(),
  checkedAt: Timestamp.nullable(),
  expectedRevision: Revision,
  applySupported: z.literal(false),
  freshness: z.literal('snapshot_only'),
  candidates: z.array(AdoptionCandidateSchema).max(64),
  conflicts: z
    .array(
      z.enum([
        'snapshot_unavailable',
        'source_drift',
        'unknown_comparison',
        'registry_not_empty',
        'candidate_name_conflict',
        'unresolved_registry_operation',
        'unsafe_native_attachment',
        'unknown_native_launcher',
        'configuration_conflict',
      ]),
    )
    .max(8),
  effects: z.tuple([
    z.literal('existing_pilot_unchanged'),
    z.literal('agents_unchanged'),
    z.literal('secrets_not_copied'),
    z.literal('connectors_not_executed'),
  ]),
});
export type DiscoveredAgent = z.infer<typeof DiscoveredAgentSchema>;
export type FileObservation = z.infer<typeof FileObservationSchema>;
export type AdoptionCandidate = z.infer<typeof AdoptionCandidateSchema>;
export type DiscoverySnapshot = z.infer<typeof DiscoverySnapshotSchema>;
export type DiscoveryJob = z.infer<typeof DiscoveryJobSchema>;
export type AdoptionPreview = z.infer<typeof AdoptionPreviewSchema>;
export const CreateProfileSchema = z.strictObject({
  kind: z.literal('create_profile'),
  expectedRevision: Revision,
  name: Name,
  description: Description,
});
export const OperationPreviewSchema = z.strictObject({
  id: IdSchema,
  expectedRevision: Revision,
  kind: LifecycleKindSchema,
  summary: z.string().max(200),
  changes: z.array(z.string().max(300)).max(32),
  warnings: z.array(z.string().max(300)).max(32),
  expiresAt: Timestamp,
  targetId: IdSchema.optional(),
  definitionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  affectedProfiles: boundedIds.optional(),
  affectedAgents: z
    .array(z.union([AgentIdSchema, IntegrationAgentIdSchema]))
    .max(10)
    .optional(),
  files: z.array(z.string().max(2048)).max(256).optional(),
});
export const JobSchema = z.strictObject({
  id: IdSchema,
  operation: LifecycleKindSchema,
  state: z.enum([
    'queued',
    'running',
    'awaiting_user_action',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
  reason: z.string().max(300).nullable(),
  resultId: IdSchema.nullable(),
});
export const AuditEventSchema = z.strictObject({
  id: IdSchema,
  time: Timestamp,
  operation: LifecycleKindSchema,
  targetId: IdSchema,
  priorRevision: Revision,
  newRevision: Revision,
  result: z.literal('succeeded'),
});
export const StateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: Revision,
    connectors: z.array(ConnectorSchema).max(256),
    profiles: z.array(ProfileSchema).max(256),
    secretReferences: z.array(SecretReferenceSchema).max(256),
    activity: z.array(AuditEventSchema).max(200),
    materializations: z.array(MaterializationSchema).max(256).optional(),
    agentBindings: z.array(AgentBindingSchema).max(2048).optional(),
    integrations: z
      .array(IntegrationRecordSchema)
      .max(24)
      .refine(
        (items) =>
          new Set(items.map((item) => item.agentId)).size === items.length,
      )
      .optional(),
    agentProfileBindings: AgentProfileBindingsSchema.optional(),
    agentToolSearchModes: AgentToolSearchModesSchema.optional(),
    toolOverrides: ToolOverridesCollectionSchema.optional(),
  })
  .superRefine((state, ctx) => {
    for (const items of [
      state.connectors,
      state.profiles,
      state.secretReferences,
    ]) {
      if (new Set(items.map((item) => item.id)).size !== items.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate registry identifiers',
        });
      }
    }
    const ids = new Set(state.connectors.map((connector) => connector.id));
    if (state.toolOverrides?.some((item) => !ids.has(item.connectorId)))
      ctx.addIssue({
        code: 'custom',
        message: 'Tool override references an unknown connector.',
      });
    if (
      Object.values(state.agentProfileBindings ?? {}).some(
        (id) => !state.profiles.some((profile) => profile.id === id),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Agent binding references an unknown profile.',
      });
    if (
      state.profiles.some((profile) =>
        profile.connectorIds.some((id) => !ids.has(id)),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Profile references an unknown connector',
      });
    }
  });

export const SessionRequestSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export const SessionResponseSchema = z.strictObject({
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ApplyRequestSchema = z.strictObject({ previewId: IdSchema });
export const BootstrapSchema = z.strictObject({
  stage: z.enum(['foundation', 'discovery']),
  revision: Revision,
  runtime: z.strictObject({
    node: z.string().max(40),
    platform: z.string().max(40),
  }),
  capabilities: z.strictObject({
    localProfiles: z.literal(true),
    importPreview: z.literal(true),
    discovery: z.boolean(),
    connectorManagement: z.boolean(),
    runtimeChecks: z.boolean(),
    materialization: z.boolean(),
    secrets: z.boolean(),
    agentApply: z.boolean(),
    desktop: z.boolean().optional(),
    playground: z.boolean().optional(),
    startup: z.boolean(),
  }),
  docker: z.enum([
    'not_checked',
    'missing',
    'available',
    'unavailable',
    'unsupported',
    'error',
  ]),
});

export type Connector = z.infer<typeof ConnectorSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type AgentObservation = z.infer<typeof AgentObservationSchema>;
export type CreateProfile = z.infer<typeof CreateProfileSchema>;
export type OperationPreview = z.infer<typeof OperationPreviewSchema>;
export type Job = z.infer<typeof JobSchema>;
export type HubState = z.infer<typeof StateSchema>;
export type Bootstrap = z.infer<typeof BootstrapSchema>;
