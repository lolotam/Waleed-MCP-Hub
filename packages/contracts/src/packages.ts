import { z } from 'zod';

// npm package names follow validate-npm-package-name: lowercase, optional scope,
// at most 214 characters.
const PackageNameSchema = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/);
// Exact semver only: no ranges, no tags, no leading "v".
const ExactVersionSchema = z
  .string()
  .max(256)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
// The bin name the user picks from the entry candidates.
const PackageEntrySchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
// The bin path relative to the package folder, normalized with "/" separators.
// Windows-reserved characters are refused (":" would name an alternate data
// stream), and so are segments ending in "." or " ", which Windows strips.
const PackageEntryPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/[\\<>:"|?*]/.test(value) &&
      [...value].every((char) => char.charCodeAt(0) > 0x1f) &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every(
          (segment) =>
            segment.length > 0 &&
            segment !== '.' &&
            segment !== '..' &&
            !/[. ]$/.test(segment),
        ),
    'Entry path must be relative, use "/" separators and stay inside the package folder.',
  );
const Sha512IntegritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PackageArgumentsSchema = z
  .array(
    z
      .string()
      .max(4096)
      .refine((arg) => !arg.includes('\0')),
  )
  .max(128);
const EnvNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
// Nothing that starts with NODE_ may reach a package connector, so no external
// code can be preloaded and no TLS trust can be changed from outside the
// install. The OpenSSL variables change how the bundled Node and npm trust
// TLS, so the exact names of the certificate variables are refused as well.
const REFUSED_PACKAGE_ENV_NAMES = new Set([
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
export const isPackageEnvName = (name: string): boolean =>
  /^NODE_/i.test(name) || REFUSED_PACKAGE_ENV_NAMES.has(name.toUpperCase());
const PackageEnvSchema = z
  .record(
    z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/),
    z.string().min(1).max(8192),
  )
  .refine(
    (env) => !Object.keys(env).some((key) => isPackageEnvName(key)),
    'Environment names starting with NODE_ and the OpenSSL certificate variables are refused on package connectors.',
  )
  .default({});
const ConnectorIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const PackageProvenanceSchema = z.strictObject({
  ecosystem: z.literal('npm'),
  name: PackageNameSchema,
  version: ExactVersionSchema,
  entry: PackageEntrySchema,
  entryPath: PackageEntryPathSchema,
  installId: z.uuid(),
  integrity: Sha512IntegritySchema,
  lockHash: Sha256HexSchema,
  manifestHash: Sha256HexSchema,
});
export const PackageErrorCodeSchema = z.enum([
  'package_not_found',
  'version_not_found',
  'no_entry',
  'entry_required',
  'unsupported_dependency',
  'registry_unavailable',
  'foreign_host',
  'install_failed',
  'install_limit',
  'integrity_mismatch',
  'preview_expired',
  'warning_not_acknowledged',
  'package_modified',
  'invalid_configuration',
  'save_uncertain',
  'busy',
  'cancelled',
]);
export const PackageWarningSchema = z.enum([
  'install_scripts',
  'install_scripts_unknown',
  'optional_omitted',
  'recent_release',
  'release_date_unknown',
  'deprecated',
  'engine_mismatch',
  'many_packages',
  'large_size',
  'size_unknown',
]);
export const PackageResolveRequestSchema = z.strictObject({
  name: PackageNameSchema,
  version: z.union([ExactVersionSchema, z.literal('latest')]).optional(),
});
// The frozen lock itself stays server-side; only its hash travels here.
export const PackagePreviewSchema = z.strictObject({
  previewId: z.uuid(),
  name: PackageNameSchema,
  version: ExactVersionSchema,
  description: z.string().max(1000).nullable(),
  integrity: Sha512IntegritySchema,
  lockHash: Sha256HexSchema,
  packageCount: z.number().int().min(1).max(100000),
  bundledCount: z.number().int().min(0).max(100000),
  unpackedSize: z.number().int().min(0).nullable(),
  releasedAt: z.iso.datetime().nullable(),
  entries: z
    .array(
      z.strictObject({
        entry: PackageEntrySchema,
        entryPath: PackageEntryPathSchema,
      }),
    )
    .min(1)
    .max(64),
  warnings: z.array(PackageWarningSchema).max(16),
  expiresAt: z.iso.datetime(),
});
export const PackageInstallRequestSchema = z.strictObject({
  previewId: z.uuid(),
  entry: PackageEntrySchema,
  acknowledgedWarnings: z.array(PackageWarningSchema).max(16),
  connectorName: z.string().trim().min(1).max(100),
  arguments: PackageArgumentsSchema,
  env: PackageEnvSchema,
});
export const PackageReplaceRequestSchema = z.strictObject({
  connectorId: ConnectorIdSchema,
  expectedConnectorRevision: z.number().int().min(1),
  previewId: z.uuid(),
  entry: PackageEntrySchema,
  acknowledgedWarnings: z.array(PackageWarningSchema).max(16),
});
export const PackageJobSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['resolve', 'install', 'replace']),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  phase: z.enum([
    'queued',
    'resolving',
    'downloading',
    'verifying',
    'saving',
    'complete',
  ]),
  progress: z.strictObject({
    downloadedBytes: z.number().int().min(0),
    packages: z.number().int().min(0),
  }),
  error: PackageErrorCodeSchema.nullable(),
  preview: PackagePreviewSchema.nullable(),
  result: z
    .strictObject({
      connectorId: ConnectorIdSchema,
      outcome: z.enum(['saved', 'partially_saved']),
    })
    .nullable(),
});
// An imported npx entry: names and arguments only, never credential values.
export const PackageProposalSchema = z.strictObject({
  name: PackageNameSchema,
  version: ExactVersionSchema.nullable(),
  arguments: PackageArgumentsSchema,
  envNames: z.array(EnvNameSchema).max(64),
});

export type PackageProvenance = z.infer<typeof PackageProvenanceSchema>;
export type PackageErrorCode = z.infer<typeof PackageErrorCodeSchema>;
export type PackageWarning = z.infer<typeof PackageWarningSchema>;
export type PackageResolveRequest = z.infer<typeof PackageResolveRequestSchema>;
export type PackagePreview = z.infer<typeof PackagePreviewSchema>;
export type PackageInstallRequest = z.infer<typeof PackageInstallRequestSchema>;
export type PackageReplaceRequest = z.infer<typeof PackageReplaceRequestSchema>;
export type PackageJob = z.infer<typeof PackageJobSchema>;
export type PackageProposal = z.infer<typeof PackageProposalSchema>;
