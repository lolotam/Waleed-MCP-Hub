import { z } from 'zod';
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
  'grok',
]);
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
  type: z.enum(['stdio', 'docker', 'streamable_http', 'sse']),
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
});
export type IntegrationAgentId = z.infer<typeof IntegrationAgentIdSchema>;
export type IntegrationRecord = z.infer<typeof IntegrationRecordSchema>;
export type AgentIntegration = z.infer<typeof AgentIntegrationSchema>;
