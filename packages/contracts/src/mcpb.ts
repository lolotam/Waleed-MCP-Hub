import { z } from 'zod';

export const MCPB_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MCPB_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MCPB_MAX_FILES = 500;
// Windows-safe, portable archive names. Reject aliases, ADS, devices and links.
export const McpbPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[\\:<>"|?*]/.test(value) &&
      ![...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) &&
      !value.startsWith('/') &&
      value.normalize('NFC') === value &&
      value
        .split('/')
        .every(
          (part) =>
            !!part &&
            !part.includes('..') &&
            part !== '.' &&
            !/[. ]$/.test(part) &&
            !/^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(
              part,
            ),
        ),
  );
const text = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      ![...value].some(
        (char) =>
          (char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char)) ||
          char.charCodeAt(0) === 127,
      ),
  );
const scalar = z.union([
  z
    .string()
    .max(8192)
    .refine((value) => !value.includes('\0')),
  z.number().finite(),
  z.boolean(),
]);
export const McpbConfigFieldSchema = z
  .strictObject({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: text,
    description: text.optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    secret: z.boolean().optional(),
    default: scalar.optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .superRefine((field, ctx) => {
    if ((field.secret || field.sensitive) && field.default !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Protected fields cannot include defaults.',
      });
    if (
      field.default !== undefined &&
      typeof field.default !==
        (field.type === 'number'
          ? 'number'
          : field.type === 'boolean'
            ? 'boolean'
            : 'string')
    )
      ctx.addIssue({ code: 'custom', message: 'Default type mismatch.' });
    if (
      ((field.min !== undefined || field.max !== undefined) &&
        field.type !== 'number') ||
      (field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid numeric bounds.' });
  });
const config = z
  .record(
    z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
      .refine(
        (key) => !['constructor', 'prototype', '__proto__'].includes(key),
      ),
    McpbConfigFieldSchema,
  )
  .refine((value) => Object.keys(value).length <= 16);
const template = z
  .string()
  .max(8192)
  .refine((value) => !/[\0\r\n]/.test(value));
export const McpbManifestSchema = z
  .strictObject({
    manifest_version: z.enum(['0.1', '0.2', '0.3']),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    display_name: text.optional(),
    version: z
      .string()
      .max(100)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    description: text,
    long_description: z.string().max(10000).optional(),
    author: z.strictObject({
      name: text,
      email: z.string().email().max(254).optional(),
      url: z.string().url().max(2048).optional(),
    }),
    homepage: z.string().url().max(2048).optional(),
    documentation: z.string().url().max(2048).optional(),
    support: z.string().url().max(2048).optional(),
    license: text.optional(),
    icon: McpbPathSchema.optional(),
    keywords: z.array(text).max(30).optional(),
    screenshots: z.array(McpbPathSchema).max(20).optional(),
    server: z.strictObject({
      type: z.enum(['node', 'python', 'binary']),
      entry_point: McpbPathSchema,
      mcp_config: z.strictObject({
        command: template,
        args: z.array(template).max(100).optional(),
        env: z
          .record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/), template)
          .refine((value) => Object.keys(value).length <= 16)
          .optional(),
      }),
    }),
    user_config: config.optional(),
    configuration: config.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.user_config && manifest.configuration)
      ctx.addIssue({
        code: 'custom',
        message: 'Use one configuration dictionary.',
      });
    const server = manifest.server;
    const entry = '${__dirname}/' + server.entry_point;
    if (
      server.type === 'binary'
        ? !/\.exe$/i.test(server.entry_point) ||
          server.mcp_config.command !== entry
        : server.mcp_config.command !==
            (server.type === 'node' ? 'node' : 'python') ||
          server.mcp_config.args?.[0] !== entry
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Only direct, declared entry-point execution is supported.',
      });
    if (
      (server.type === 'node' &&
        !/\.(?:js|mjs|cjs)$/i.test(server.entry_point)) ||
      (server.type === 'python' && !/\.py$/i.test(server.entry_point))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Entry-point runtime mismatch.',
      });
  });
export const McpbBundleSchema = z.strictObject({
  id: z.uuid(),
  archiveHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z
    .array(
      z.strictObject({
        path: McpbPathSchema,
        size: z.number().int().nonnegative().max(MCPB_MAX_UNCOMPRESSED_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(MCPB_MAX_FILES),
});
export const McpbInstallSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  confirmInstall: z.literal(true),
  configuration: z.record(z.string().max(64), scalar),
});
export type McpbManifest = z.infer<typeof McpbManifestSchema>;
export type McpbBundle = z.infer<typeof McpbBundleSchema>;
export interface McpbPreview {
  id: string;
  manifest: McpbManifest;
  archiveHash: string;
  fileCount: number;
  uncompressedBytes: number;
  expiresAt: string;
}
