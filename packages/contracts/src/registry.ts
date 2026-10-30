import { z } from 'zod';
const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) =>
        ![...value].some((char) => {
          const c = char.charCodeAt(0);
          return c < 32 || c === 127;
        }),
    );
export const RegistrySearchSchema = z.strictObject({
  search: safeText(100).default(''),
  cursor: safeText(2048).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const RegistryPrefillSchema = z.strictObject({
  name: safeText(100),
  type: z.enum(['npx', 'uvx', 'streamable_http', 'sse']),
  packageName: z.string().max(214).optional(),
  packageVersion: z.string().max(100).optional(),
  entryPoint: z.string().max(100).optional(),
  url: z.string().max(2048).optional(),
  args: z.array(z.string().max(4096)).max(128),
});
export const RegistryOptionSchema = z.strictObject({
  id: z.string().max(80),
  prefill: RegistryPrefillSchema,
  requirements: z
    .array(
      z.strictObject({
        name: safeText(100),
        location: z.enum(['environment', 'header']),
        required: z.boolean(),
        secret: z.boolean(),
        description: safeText(1000),
      }),
    )
    .max(64),
  warnings: z.array(safeText(200)).max(16),
});
export const RegistryServerSchema = z.strictObject({
  name: safeText(200),
  title: safeText(100),
  description: safeText(1000),
  version: safeText(100),
  options: z.array(RegistryOptionSchema).max(32),
  unsupportedOptions: z.number().int().nonnegative().max(256),
});
export const RegistryResultSchema = z.strictObject({
  source: z.literal('https://registry.modelcontextprotocol.io'),
  servers: z.array(RegistryServerSchema).max(50),
  nextCursor: safeText(2048).nullable(),
});
export type RegistryServer = z.infer<typeof RegistryServerSchema>;
export type RegistryOption = z.infer<typeof RegistryOptionSchema>;
export type RegistryPrefill = z.infer<typeof RegistryPrefillSchema>;
