import { z } from 'zod';
import { HttpClientAgentIdSchema } from './http-transport.js';
import { ToolPolicyNameSchema, ToolPolicySchema } from './integrations.js';
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ToolCallRecordSchema = z.strictObject({
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  agentId: z.union([HttpClientAgentIdSchema, z.literal('hub_playground')]),
  connectorId: id,
  toolName: ToolPolicyNameSchema,
  durationMs: integer,
  resultSizeBytes: integer,
  status: z.enum(['success', 'error', 'blocked', 'declined']),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
export const PlaygroundInvokeRequestSchema = z.strictObject({
  connectorId: id,
  toolName: ToolPolicyNameSchema,
  arguments: z
    .preprocess(
      (value, ctx) => {
        if (
          value &&
          typeof value === 'object' &&
          Object.hasOwn(value, '__proto__')
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Unsupported argument key.',
          });
        return value;
      },
      z.record(z.string(), z.unknown()),
    )
    .optional(),
  confirmExecute: z.literal(true),
  expectedRevision: integer.optional(),
  expectedConnectorRevision: integer.optional(),
  expectedDefinitionHash: hash.optional(),
  expectedToolSchemaHash: hash.optional(),
});
export const PlaygroundCatalogRequestSchema = z.strictObject({
  connectorId: id,
});
export const PlaygroundCatalogSchema = z.strictObject({
  connectorId: id,
  revision: integer,
  connectorRevision: integer,
  definitionHash: hash,
  truncated: z.boolean(),
  tools: z
    .array(
      z.strictObject({
        name: ToolPolicyNameSchema,
        description: z.string().max(1000),
        inputSchema: z.looseObject({ type: z.literal('object') }),
        schemaHash: hash,
        policy: ToolPolicySchema,
      }),
    )
    .max(4096),
});
export const PlaygroundResultSchema = z.strictObject({
  isError: z.boolean(),
  output: z.string().max(16384),
});
export const PlaygroundJobSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  result: PlaygroundResultSchema.nullable(),
});
export type PlaygroundCatalog = z.infer<typeof PlaygroundCatalogSchema>;
export type PlaygroundResult = z.infer<typeof PlaygroundResultSchema>;
export type PlaygroundJob = z.infer<typeof PlaygroundJobSchema>;
export const RequestLogResponseSchema = z.strictObject({
  records: z.array(ToolCallRecordSchema).max(500),
  capacity: z.literal(500),
  agentLogChannel: z.enum(['available', 'unavailable', 'not_configured']),
});
export type RequestLogResponse = z.infer<typeof RequestLogResponseSchema>;
