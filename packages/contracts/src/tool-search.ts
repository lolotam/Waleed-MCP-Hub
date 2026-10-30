import { z } from 'zod';

export const SearchToolsArgumentsSchema = z.strictObject({
  query: z.string().max(256),
  limit: z.number().int().min(1).max(50).default(10),
});
export const CallToolArgumentsSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
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
});
// MCP tool metadata is inert, provider-supplied data. Preserve JSON Schema
// extensions rather than interpreting or evaluating them in the Hub.
export const SearchToolSchema = z.looseObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().max(2000).optional(),
  inputSchema: z.looseObject({ type: z.literal('object') }),
  outputSchema: z.looseObject({ type: z.literal('object') }).optional(),
});
export const SearchToolsResultSchema = z.strictObject({
  tools: z.array(SearchToolSchema).max(50),
  hasMore: z.boolean(),
  truncated: z.boolean(),
});
export const CallToolResultSchema = z.looseObject({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
export type SearchToolsArguments = z.infer<typeof SearchToolsArgumentsSchema>;
export type SearchToolsResult = z.infer<typeof SearchToolsResultSchema>;
export type CallToolArguments = z.infer<typeof CallToolArgumentsSchema>;
