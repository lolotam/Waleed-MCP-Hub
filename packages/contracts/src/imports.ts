import { z } from 'zod';
import { PortBindingsSchema } from './integrations.js';
import { PackageSpecSchema } from './packages.js';
import { EndpointSchema } from './endpoints.js';

const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const Name = z.string().trim().min(1).max(100);
const Bindings = z
  .record(
    z
      .string()
      .max(100)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
    Id,
  )
  .refine((bindings) => Object.keys(bindings).length <= 64);
const Args = z
  .array(
    z
      .string()
      .max(4096)
      .refine((value) => !/[\0\r\n]/.test(value)),
  )
  .max(128);
const common = {
  id: Id,
  name: Name,
  description: z.string().max(1000),
  enabled: z.boolean(),
  environmentLiterals: z.record(z.string().max(100), z.string().max(100)),
  secretBindings: Bindings,
  headerBindings: Bindings,
  credentialFormats: z
    .record(z.string(), z.enum(['raw', 'bearer', 'basic']))
    .optional(),
  trustApproval: z.null(),
};
export const ImportDefinitionSchema = z.discriminatedUnion('executionMode', [
  z.strictObject({
    ...common,
    executionMode: z.literal('package'),
    transport: z.literal('stdio'),
    package: PackageSpecSchema,
    arguments: Args,
  }),
  z.strictObject({
    ...common,
    executionMode: z.literal('remote'),
    transport: z.enum(['streamable_http', 'sse']),
    endpoint: EndpointSchema,
    localHttpOptIn: z.boolean().optional(),
  }),
  z.strictObject({
    ...common,
    executionMode: z.literal('native'),
    transport: z.literal('stdio'),
    executable: z.string().max(1024),
    arguments: Args,
  }),
  z.strictObject({
    ...common,
    executionMode: z.literal('docker'),
    transport: z.literal('stdio'),
    image: z.string().max(256),
    portBindings: PortBindingsSchema.optional(),
    command: Args,
    arguments: Args,
  }),
]);
export const ImportIssueSchema = z.strictObject({
  code: z.enum([
    'invalid_entry',
    'ambiguous_shape',
    'unsupported_fields',
    'invalid_name',
    'invalid_id',
    'invalid_transport',
    'invalid_endpoint',
    'invalid_command',
    'invalid_arguments',
    'invalid_bindings',
    'unresolved_reference',
    'credential_in_definition',
    'unsafe_literal',
    'local_http_opt_in_required',
  ]),
  field: z.string().max(100),
});
export const ImportWarningSchema = z.enum([
  'native_execution_approval',
  'image_execution_approval',
  'network_access',
  'host_file_access',
  'package_download',
  'unpinned_package',
  'image_pull',
  'unpinned_image',
  'shell_syntax_inert',
  'shell_interpreter',
  'script_adapter_pending',
  'destination_review',
  'secrets_memory_only',
  'disabled_entry',
  'local_http_opt_in',
]);
export const ImportEntrySchema = z.strictObject({
  key: Id,
  selected: z.boolean(),
  name: Name,
  id: Id,
  definition: ImportDefinitionSchema.nullable(),
  localHttpEndpoint: EndpointSchema.optional(),
  issues: z.array(ImportIssueSchema).max(100),
  warnings: z.array(ImportWarningSchema).max(20),
  conflicts: z
    .array(
      z.enum([
        'duplicate_name',
        'duplicate_id',
        'existing_name',
        'existing_id',
      ]),
    )
    .max(4),
});
export const ImportPreviewRequestSchema = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(48 * 1024),
  expectedRevision: Revision,
});
export const ImportSavePreviewRequestSchema = z.strictObject({
  expectedRevision: Revision,
});
export const ImportSelectionSchema = z.strictObject({
  expectedRevision: Revision,
  entries: z
    .array(
      z.strictObject({
        key: Id,
        selected: z.boolean(),
        name: Name,
        id: Id,
        packageVersion: z.string().max(100).optional(),
        entryPoint: z.string().max(100).optional(),
        localHttpOptIn: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(32),
});
export const ImportPreviewSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: Revision,
  expiresAt: z.iso.datetime(),
  format: z.enum(['single', 'mcpServers', 'servers', 'opencode', 'docker']),
  entries: z.array(ImportEntrySchema).min(1).max(32),
  secretReferences: z
    .array(
      z.strictObject({
        id: Id,
        location: z.enum(['environment', 'header']),
        storage: z.literal('memory_only'),
      }),
    )
    .max(256),
  selectionReady: z.boolean(),
  applySupported: z.boolean(),
  blockers: z
    .array(
      z.enum([
        'no_selection',
        'invalid_selection',
        'conflicts',
        'registry_capacity',
        'recovery_required',
      ]),
    )
    .max(5),
  effects: z.strictObject({
    scope: z.literal('preview_only'),
    files: z.array(z.string()).length(0),
    affectedAgents: z.array(z.string()).length(0),
    registryWrites: z.literal(false),
    secretStoreWrites: z.literal(false),
    processes: z.literal(0),
    networkRequests: z.literal(0),
    proposedConnectorCount: z.number().int().min(0).max(32),
    downloads: z
      .array(
        z.enum(['package_download_on_execution', 'image_pull_on_execution']),
      )
      .max(2),
    permissions: z
      .array(
        z.enum([
          'network_on_execution',
          'host_files_on_execution',
          'container_on_execution',
        ]),
      )
      .max(3),
  }),
});
export type ImportDefinition = z.infer<typeof ImportDefinitionSchema>;
export type ImportEntry = z.infer<typeof ImportEntrySchema>;
export type ImportIssue = z.infer<typeof ImportIssueSchema>;
export type ImportWarning = z.infer<typeof ImportWarningSchema>;
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
export type ImportSelection = z.infer<typeof ImportSelectionSchema>;
export const ImportApplySchema = z.strictObject({
  expectedRevision: Revision,
  profileIds: z
    .array(Id)
    .min(1)
    .max(32)
    .refine((ids) => new Set(ids).size === ids.length),
  confirmImport: z.literal(true),
  confirmAgentConfigChange: z.boolean().default(false),
});
export const AgentImportPreviewSchema = z.strictObject({
  expectedRevision: Revision,
});
