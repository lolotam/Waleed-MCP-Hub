import { z } from 'zod';

const entryPoint = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((value) => !/\.(?:cmd|bat|ps1|exe)$/i.test(value));
// No tags, ranges, URLs, local paths, VCS references or installer flags.
export const PackageSpecSchema = z.discriminatedUnion('manager', [
  z.strictObject({
    manager: z.literal('npm'),
    name: z
      .string()
      .min(1)
      .max(214)
      .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
    version: z
      .string()
      .max(100)
      .regex(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    entryPoint,
  }),
  z.strictObject({
    manager: z.literal('uvx'),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    version: z
      .string()
      .max(100)
      .regex(/^\d+(?:\.\d+)+(?:a\d+|b\d+|rc\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/),
    entryPoint,
  }),
]);
export type PackageSpec = z.infer<typeof PackageSpecSchema>;
