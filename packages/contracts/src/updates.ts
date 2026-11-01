import { z } from 'zod';
export const UpdateStatusSchema = z.strictObject({
  currentVersion: z.string().max(40),
  latestVersion: z.string().max(40).nullable(),
  state: z.enum(['not_checked', 'current', 'available', 'unavailable']),
  checkedAt: z.iso.datetime().nullable(),
  reason: z.enum([
    'none',
    'no_release',
    'network',
    'rate_limit',
    'invalid_response',
  ]),
  releaseUrl: z.string().max(300).nullable(),
  downloadUrl: z.string().max(300).nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
