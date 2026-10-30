import { z } from 'zod';
import { EndpointSchema } from './endpoints.js';
import { PackageSpecSchema } from './packages.js';
import {
  IntegrationAgentIdSchema,
  PortBindingsSchema,
  ToolPoliciesSchema,
} from './integrations.js';
import {
  ToolOverrideSchema,
  ToolOverridesCollectionSchema,
} from './tool-overrides.js';

export const SETUP_MAX_BYTES = 512 * 1024;
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)
  .refine(
    (value) => !['constructor', 'prototype', '__proto__'].includes(value),
  );
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().trim().min(1).max(100);
const args = z
  .array(
    z
      .string()
      .max(4096)
      .refine((value) => !/[\0\r\n]/.test(value)),
  )
  .max(128);
export const SetupRequiredSecretSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
    .refine(
      (value) => !['constructor', 'prototype', '__proto__'].includes(value),
    ),
  target: z.enum(['environment', 'header']),
  format: z.enum(['raw', 'bearer', 'basic']),
  description: z.string().max(200).optional(),
});
const common = {
  id,
  name,
  description: z.string().max(1000),
  enabled: z.boolean(),
  environmentLiterals: z.record(z.string().max(100), z.string().max(100)),
  requiredSecrets: z.array(SetupRequiredSecretSchema).max(64),
  policies: ToolPoliciesSchema,
};
export const SetupConnectorSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...common,
      type: z.literal('native'),
      command: z.string().min(1).max(1024),
      args,
    }),
    z.strictObject({
      ...common,
      type: z.literal('package'),
      package: PackageSpecSchema,
      args,
    }),
    z.strictObject({
      ...common,
      type: z.literal('docker'),
      image: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/),
      command: args,
      args,
      portBindings: PortBindingsSchema.optional(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('remote'),
      url: EndpointSchema,
      transport: z.enum(['streamable_http', 'sse']),
      localHttpOptIn: z.boolean().optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    const keys = value.requiredSecrets.map(
      (secret) => `${secret.target}/${secret.key.toLowerCase()}`,
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate credential field.' });
    if (
      value.requiredSecrets.some((secret) =>
        value.type === 'remote'
          ? secret.target !== 'header'
          : secret.target !== 'environment',
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Credential target does not match transport.',
      });
    if (
      value.type === 'remote' &&
      Object.keys(value.environmentLiterals).length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Remote environments are not supported.',
      });
    if (
      value.requiredSecrets.some(
        (secret) =>
          secret.target === 'environment' &&
          Object.keys(value.environmentLiterals).some(
            (key) => key.toLowerCase() === secret.key.toLowerCase(),
          ),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Environment field has two sources.',
      });
  });
export const setupOverrideKey = (value: {
  connectorId: string;
  originalToolName: string;
}) => `${value.connectorId}/${value.originalToolName}`;
export const setupCredentialKey = (
  connectorId: string,
  secret: { target: string; key: string },
) => `${connectorId}/${secret.target}/${secret.key}`;
export const ExportSetupBundleSchema = z
  .strictObject({
    version: z.literal(1),
    exportedAt: z.iso.datetime(),
    connectors: z.array(SetupConnectorSchema).max(256),
    profiles: z
      .array(
        z.strictObject({
          id,
          name,
          description: z.string().max(1000),
          enabled: z.boolean(),
          connectorIds: z.array(id).max(256),
        }),
      )
      .max(256),
    agentProfileBindings: z.partialRecord(IntegrationAgentIdSchema, id),
    toolOverrides: z.record(z.string().min(1).max(145), ToolOverrideSchema),
  })
  .superRefine((value, ctx) => {
    const connectorIds = new Set(value.connectors.map((item) => item.id)),
      profileIds = new Set(value.profiles.map((item) => item.id));
    if (
      connectorIds.size !== value.connectors.length ||
      profileIds.size !== value.profiles.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate setup identity.' });
    if (
      value.profiles.some(
        (profile) =>
          new Set(profile.connectorIds).size !== profile.connectorIds.length ||
          profile.connectorIds.some((id) => !connectorIds.has(id)),
      ) ||
      Object.values(value.agentProfileBindings).some(
        (id) => !profileIds.has(id),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Unresolved setup reference.' });
    if (
      Object.entries(value.toolOverrides).some(
        ([key, item]) =>
          key !== setupOverrideKey(item) || !connectorIds.has(item.connectorId),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid override identity.' });
    if (
      !ToolOverridesCollectionSchema.safeParse(
        Object.values(value.toolOverrides),
      ).success
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid override collection.' });
    if (
      value.connectors.reduce(
        (sum, item) => sum + item.requiredSecrets.length,
        0,
      ) > 256
    )
      ctx.addIssue({ code: 'custom', message: 'Too many credentials.' });
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      SETUP_MAX_BYTES
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Setup exceeds the size limit.',
      });
  });
export const SetupConflictStrategySchema = z.enum([
  'skip_existing',
  'overwrite_existing',
]);
export const ImportSetupPreviewRequestSchema = z.strictObject({
  source: z.string().min(1).max(SETUP_MAX_BYTES),
  conflictStrategy: SetupConflictStrategySchema,
});
const summary = z.strictObject({
  id,
  name,
  action: z.enum(['add', 'skip', 'overwrite']),
});
export const ImportSetupPreviewSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: revision,
  expiresAt: z.iso.datetime(),
  conflictStrategy: SetupConflictStrategySchema,
  bundle: ExportSetupBundleSchema,
  connectors: z.array(summary).max(256),
  profiles: z.array(summary).max(256),
  collisions: z
    .array(z.strictObject({ id, kind: z.enum(['connector', 'profile']) }))
    .max(512),
  missingSecrets: z
    .array(
      SetupRequiredSecretSchema.extend({
        connectorId: id,
        inputKey: z.string().max(200),
      }),
    )
    .max(256),
  warnings: z.array(z.string().max(300)).max(10),
});
export const ImportSetupApplyRequestSchema = z.strictObject({
  previewId: z.uuid(),
  expectedRevision: revision,
  conflictStrategy: SetupConflictStrategySchema,
  credentials: z
    .record(
      z.string().min(1).max(200),
      z
        .string()
        .min(1)
        .max(8192)
        .refine((value) => !/[\0\r\n]/.test(value)),
    )
    .refine((value) => Object.keys(value).length <= 256),
});
export type ExportSetupBundle = z.infer<typeof ExportSetupBundleSchema>;
export type SetupConnector = z.infer<typeof SetupConnectorSchema>;
export type ImportSetupPreview = z.infer<typeof ImportSetupPreviewSchema>;
export type SetupConflictStrategy = z.infer<typeof SetupConflictStrategySchema>;
