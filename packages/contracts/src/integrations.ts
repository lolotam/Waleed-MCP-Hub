import { z } from 'zod';
export const ToolPolicySchema = z.enum(['allow', 'ask', 'block']);
export const ToolPolicyNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((key) => !['constructor', 'prototype', '__proto__'].includes(key));
// Zod records intentionally skip __proto__; reject it on the raw object rather
// than silently dropping a forbidden policy key during parsing.
export const ToolPoliciesSchema = z.preprocess(
  (value, ctx) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, '__proto__'))
      ctx.addIssue({ code: 'custom', message: 'Forbidden tool policy key.' });
    return value;
  },
  z
    .record(ToolPolicyNameSchema, ToolPolicySchema)
    .refine((policies) => Object.keys(policies).length <= 256),
);
export const ToolPoliciesUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedConnectorRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  toolPolicies: ToolPoliciesSchema,
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export const PortBindingsSchema = z
  .array(
    z.strictObject({
      host: z.number().int().min(1024).max(65535),
      container: z.number().int().min(1).max(65535),
    }),
  )
  .max(16)
  .refine(
    (items) => new Set(items.map((item) => item.host)).size === items.length,
  );

export const IntegrationAgentIdSchema = z.enum([
  'opencode',
  'codex',
  'claude-desktop',
  'claude',
  'antigravity',
  'vscode',
  'cursor',
  'kimi',
  'kilo',
  'windsurf',
  'cline',
  'roo-code',
  'zed',
  'gemini-cli',
  'goose',
  'jetbrains',
  'warp',
]);
const profileId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
export const AgentToolSearchModesSchema = z.preprocess(
  (value, ctx) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, '__proto__'))
      ctx.addIssue({ code: 'custom', message: 'Forbidden agent setting key.' });
    return value;
  },
  z
    .partialRecord(IntegrationAgentIdSchema, z.boolean())
    .refine((modes) => Object.keys(modes).length <= 24),
);
export const AgentToolSearchUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  toolSearchMode: z.boolean(),
});
export const AgentProfileUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  profileId: profileId.nullable(),
});
export const AgentToolSetSchema = z.strictObject({
  agentId: IntegrationAgentIdSchema,
  profileId: profileId.nullable(),
  profileState: z.enum(['all', 'enabled', 'disabled', 'missing']),
  connectorCount: z.number().int().min(0).max(256),
  toolCount: z.number().int().min(0).max(4096),
  toolSearchMode: z.boolean().optional(),
  unverifiedConnectorCount: z.number().int().min(0).max(256),
});
export const AgentToolSetsSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  toolSets: z
    .array(AgentToolSetSchema)
    .max(24)
    .refine(
      (items) =>
        new Set(items.map((item) => item.agentId)).size === items.length,
    ),
});
export type AgentToolSet = z.infer<typeof AgentToolSetSchema>;
export type AgentToolSets = z.infer<typeof AgentToolSetsSchema>;
export const IntegrationRecordSchema = z.strictObject({
  agentId: IntegrationAgentIdSchema,
  configPath: z.string().max(2048),
  entryHash: z.string().regex(/^[a-f0-9]{64}$/),
  syncedRevision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export const AgentIntegrationSchema = z.strictObject({
  agentId: IntegrationAgentIdSchema,
  name: z.string(),
  detected: z.boolean(),
  executable: z.string().nullable(),
  configPath: z.string(),
  version: z.string().nullable(),
  status: z.enum(['integrated', 'not_integrated', 'unknown']),
  reason: z.enum([
    'none',
    'not_installed',
    'scan_required',
    'unsafe_config',
    'conflict',
    'ambiguous_scope',
  ]),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  reconnect: z.string(),
  verification: z.literal('configuration_only'),
});
export const AgentChangeSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  confirmConfigurationChange: z.literal(true),
});
export const ManualMcpSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(100),
  type: z.enum(['stdio', 'docker', 'streamable_http', 'sse', 'npx', 'uvx']),
  packageName: z.string().max(214).default(''),
  packageVersion: z.string().max(100).default(''),
  entryPoint: z.string().max(100).default(''),
  command: z.string().max(1024).default(''),
  args: z.array(z.string().max(4096)).max(128).default([]),
  image: z.string().max(256).default(''),
  url: z.string().max(2048).default(''),
  env: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/),
      z.string().min(1).max(8192),
    )
    .default({}),
  headers: z
    .record(z.string().max(100), z.string().min(1).max(8192))
    .default({}),
  ports: PortBindingsSchema.default([]),
  approveExecution: z.boolean().default(false),
  autoSync: z.boolean().default(false),
  confirmSave: z.literal(true),
  localHttpOptIn: z.boolean().default(false),
});
export type IntegrationAgentId = z.infer<typeof IntegrationAgentIdSchema>;
export type IntegrationRecord = z.infer<typeof IntegrationRecordSchema>;
export type AgentIntegration = z.infer<typeof AgentIntegrationSchema>;
