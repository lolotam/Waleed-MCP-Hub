import { z } from 'zod';
import { ToolPolicyNameSchema } from './integrations.js';
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ToolAliasSchema = ToolPolicyNameSchema.refine(
  (name) => !['search_tools', 'call_tool'].includes(name.toLowerCase()),
  'Reserved meta-tool name.',
);
function safeJson(value: unknown, depth = 0, counter = { nodes: 0 }): boolean {
  if (++counter.nodes > 512 || depth > 8) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => safeJson(item, depth + 1, counter));
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key.length <= 128 &&
      !['__proto__', 'prototype', 'constructor'].includes(key) &&
      safeJson(item, depth + 1, counter),
  );
}
export const ToolOverrideAnnotationsSchema = z
  .preprocess(
    (value, ctx) => {
      if (!safeJson(value)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Annotations must be bounded inert JSON without unsafe keys.',
        });
        return {};
      }
      return value;
    },
    z.record(z.string(), z.unknown()),
  )
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8192)
      ctx.addIssue({
        code: 'custom',
        message: 'Annotations exceed the metadata limit.',
      });
    for (const key of [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ])
      if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean')
        ctx.addIssue({
          code: 'custom',
          message: 'MCP hints must be booleans.',
        });
    if (
      Object.hasOwn(value, 'title') &&
      (typeof value.title !== 'string' || value.title.length > 2000)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'MCP annotation title is invalid.',
      });
  });
export const ToolOverrideSchema = z
  .strictObject({
    connectorId: id,
    originalToolName: ToolPolicyNameSchema,
    alias: ToolAliasSchema.optional(),
    customDescription: z.string().max(2000).optional(),
    annotations: ToolOverrideAnnotationsSchema.optional(),
  })
  .refine(
    (value) =>
      value.alias !== undefined ||
      value.customDescription !== undefined ||
      value.annotations !== undefined,
    'An override must customize at least one field.',
  );
export const ToolOverridesCollectionSchema = z
  .array(ToolOverrideSchema)
  .max(512)
  .superRefine((values, ctx) => {
    const identities = new Set<string>(),
      aliases = new Set<string>();
    for (const value of values) {
      const key = JSON.stringify([value.connectorId, value.originalToolName]);
      if (identities.has(key))
        ctx.addIssue({ code: 'custom', message: 'Duplicate tool override.' });
      identities.add(key);
      if (value.alias) {
        if (aliases.has(value.alias))
          ctx.addIssue({
            code: 'custom',
            message: 'Tool aliases must be unique.',
          });
        aliases.add(value.alias);
      }
    }
    if (
      new TextEncoder().encode(JSON.stringify(values)).byteLength >
      256 * 1024
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Tool override metadata limit reached.',
      });
  });
export const ToolOverrideUpdateSchema = z.strictObject({
  expectedRevision: integer,
  expectedConnectorRevision: integer,
  originalToolName: ToolPolicyNameSchema,
  override: ToolOverrideSchema.nullable(),
});
export type ToolOverride = z.infer<typeof ToolOverrideSchema>;
