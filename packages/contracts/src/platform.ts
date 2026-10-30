import { z } from 'zod';

export const NativeSecretAdapterSchema = z.enum([
  'windows',
  'keychain',
  'libsecret',
]);
export const SecretAdapterSchema = z.enum([
  'windows',
  'keychain',
  'libsecret',
  'docker',
]);
export const SecretStorageKindSchema = z.enum([
  'dpapi',
  'keychain',
  'libsecret',
  'unavailable',
]);
export type NativeSecretAdapter = z.infer<typeof NativeSecretAdapterSchema>;
export type SecretStorageKind = z.infer<typeof SecretStorageKindSchema>;
export const CredentialStorageStatusSchema = z.strictObject({
  backend: SecretStorageKindSchema,
  name: z.enum([
    'Windows DPAPI',
    'macOS Keychain',
    'Linux Secret Service / libsecret',
    'Unavailable',
  ]),
  state: z.enum(['not_checked', 'available', 'unavailable', 'not_configured']),
  checkedAt: z.iso.datetime().nullable(),
  containment: z.enum([
    'windows-job-object',
    'posix-process-group',
    'unavailable',
  ]),
});
export type CredentialStorageStatus = z.infer<
  typeof CredentialStorageStatusSchema
>;
