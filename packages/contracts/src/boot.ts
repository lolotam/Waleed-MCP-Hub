import { z } from 'zod';

// The boot record names one hub generation: a fresh identifier after every
// restart. The install record names one installation and never changes.
const LowerUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'A lower-case UUID is required.',
  );
const PositiveInteger = z.number().int().positive();
export const BootRecordSchema = z.strictObject({
  bootId: LowerUuid,
  startedAt: PositiveInteger,
});
export const InstallRecordSchema = z.strictObject({
  installId: LowerUuid,
  createdAt: PositiveInteger,
});
