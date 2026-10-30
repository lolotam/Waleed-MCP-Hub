import { describe, expect, it } from 'vitest';
import {
  CapabilityObservationSchema,
  ConnectorSchema,
  ImportDefinitionSchema,
  ManualMcpSchema,
  PackageErrorCodeSchema,
  PackageInstallRequestSchema,
  PackageJobSchema,
  PackagePreviewSchema,
  PackageProposalSchema,
  PackageProvenanceSchema,
  PackageResolveRequestSchema,
  type PackageJob,
  type PackagePreview,
  type PackageProposal,
  type PackageProvenance,
  type PackageWarning,
} from '@waleed/contracts';
import { syntheticConnector } from './fixtures/native-connector.js';

const validProvenance: PackageProvenance = {
  ecosystem: 'npm',
  name: 'srv',
  version: '1.2.3',
  entry: 'cli',
  entryPath: 'dist/cli.js',
  installId: '12345678-1234-4234-8234-123456789abc',
  integrity: `sha512-${'a'.repeat(86)}==`,
  lockHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64),
};

describe('F01 package contracts', () => {
  describe('ConnectorSchema & ImportDefinitionSchema', () => {
    it('accepts valid package provenance on native syntheticConnector and round-trips unchanged', () => {
      const nativeWithPackage = {
        ...syntheticConnector,
        package: validProvenance,
      };
      expect(ConnectorSchema.parse(nativeWithPackage)).toEqual(
        nativeWithPackage,
      );
    });

    it('rejects package provenance on remote connector', () => {
      const remoteConnector = {
        id: 'synthetic-remote',
        name: 'Synthetic Remote MCP',
        description: '',
        enabled: true,
        revision: 1,
        secretBindings: {},
        headerBindings: {},
        trustApproval: null,
        createdAt: '2026-10-28T00:00:00.000Z',
        updatedAt: '2026-10-28T00:00:00.000Z',
        executionMode: 'remote' as const,
        transport: 'streamable_http' as const,
        endpoint: 'https://example.test/mcp',
      };
      expect(
        ConnectorSchema.safeParse({
          ...remoteConnector,
          package: validProvenance,
        }).success,
      ).toBe(false);
    });

    it('rejects package provenance on docker connector', () => {
      const dockerConnector = {
        id: 'synthetic-docker',
        name: 'Synthetic Docker MCP',
        description: '',
        enabled: true,
        revision: 1,
        secretBindings: {},
        headerBindings: {},
        trustApproval: null,
        createdAt: '2026-10-28T00:00:00.000Z',
        updatedAt: '2026-10-28T00:00:00.000Z',
        executionMode: 'docker' as const,
        transport: 'stdio' as const,
        image: 'docker.io/library/node:24',
        arguments: [],
      };
      expect(
        ConnectorSchema.safeParse({
          ...dockerConnector,
          package: validProvenance,
        }).success,
      ).toBe(false);
    });

    it('behaves identically for ImportDefinitionSchema native, remote, and docker variants', () => {
      const baseImport = {
        id: 'import-item',
        name: 'Import Item',
        description: '',
        enabled: true,
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        trustApproval: null,
      };

      const nativeImport = {
        ...baseImport,
        executionMode: 'native' as const,
        transport: 'stdio' as const,
        executable: 'node',
        arguments: ['dist/cli.js'],
        package: validProvenance,
      };
      expect(ImportDefinitionSchema.parse(nativeImport)).toEqual(nativeImport);

      const remoteImport = {
        ...baseImport,
        executionMode: 'remote' as const,
        transport: 'streamable_http' as const,
        endpoint: 'https://example.test/mcp',
      };
      expect(
        ImportDefinitionSchema.safeParse({
          ...remoteImport,
          package: validProvenance,
        }).success,
      ).toBe(false);

      const dockerImport = {
        ...baseImport,
        executionMode: 'docker' as const,
        transport: 'stdio' as const,
        image: 'docker.io/library/node:24',
        command: ['node'],
        arguments: ['dist/cli.js'],
      };
      expect(
        ImportDefinitionSchema.safeParse({
          ...dockerImport,
          package: validProvenance,
        }).success,
      ).toBe(false);
    });
  });

  describe('PackageProvenanceSchema field rules', () => {
    describe('version', () => {
      it.each(['1.2.3', '0.0.1-beta.1', '1.0.0+build.5'])(
        'accepts valid semver: %s',
        (version) => {
          expect(
            PackageProvenanceSchema.safeParse({ ...validProvenance, version })
              .success,
          ).toBe(true);
        },
      );

      it.each([
        '^1.2.3',
        '~1.2.3',
        '1.2',
        'latest',
        'v1.2.3',
        '01.2.3',
        '1.2.3 || 2.0.0',
      ])('rejects non-exact version: %s', (version) => {
        expect(
          PackageProvenanceSchema.safeParse({ ...validProvenance, version })
            .success,
        ).toBe(false);
      });
    });

    describe('name', () => {
      it.each(['srv', '@scope/srv', 'a.b-c_d'])(
        'accepts valid package name: %s',
        (name) => {
          expect(
            PackageProvenanceSchema.safeParse({ ...validProvenance, name })
              .success,
          ).toBe(true);
        },
      );

      it.each([
        'Srv',
        '@Scope/srv',
        'a'.repeat(215),
        '../srv',
        'srv/extra',
        '',
      ])('rejects invalid package name: %s', (name) => {
        expect(
          PackageProvenanceSchema.safeParse({ ...validProvenance, name })
            .success,
        ).toBe(false);
      });
    });

    describe('entryPath', () => {
      it.each(['dist/cli.js', 'bin/server'])(
        'accepts valid entryPath: %s',
        (entryPath) => {
          expect(
            PackageProvenanceSchema.safeParse({ ...validProvenance, entryPath })
              .success,
          ).toBe(true);
        },
      );

      it.each([
        '../cli.js',
        'dist/../cli.js',
        'dist\\cli.js',
        '/dist/cli.js',
        'C:/dist/cli.js',
        'dist//cli.js',
        './cli.js',
        'cli.js:stream',
        'cli.js.',
        'cli.js ',
        'a?b',
        'a<b',
        'dist/\u0001.js',
        '\u0001',
        'dist/\0.js',
        '\0',
      ])('rejects bad entryPath: %s', (entryPath) => {
        expect(
          PackageProvenanceSchema.safeParse({ ...validProvenance, entryPath })
            .success,
        ).toBe(false);
      });
    });

    describe('entry', () => {
      it.each(['../x', 'a/b', '', '-x'])(
        'rejects invalid entry: %s',
        (entry) => {
          expect(
            PackageProvenanceSchema.safeParse({ ...validProvenance, entry })
              .success,
          ).toBe(false);
        },
      );
    });

    describe('integrity', () => {
      it('accepts sha512- + 86 base64 chars + ==', () => {
        const validIntegrity = `sha512-${'a'.repeat(86)}==`;
        expect(
          PackageProvenanceSchema.safeParse({
            ...validProvenance,
            integrity: validIntegrity,
          }).success,
        ).toBe(true);
      });

      it.each([
        'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
        `sha512-${'a'.repeat(85)}==`,
        `sha512-${'a'.repeat(86)}`,
        `sha512-${'a'.repeat(88)}`,
      ])('rejects malformed integrity: %s', (integrity) => {
        expect(
          PackageProvenanceSchema.safeParse({ ...validProvenance, integrity })
            .success,
        ).toBe(false);
      });
    });

    describe('lockHash and manifestHash', () => {
      it.each(['A'.repeat(64), 'a'.repeat(63)])(
        'rejects invalid lockHash: %s',
        (lockHash) => {
          expect(
            PackageProvenanceSchema.safeParse({ ...validProvenance, lockHash })
              .success,
          ).toBe(false);
        },
      );

      it.each(['A'.repeat(64), 'a'.repeat(63)])(
        'rejects invalid manifestHash: %s',
        (manifestHash) => {
          expect(
            PackageProvenanceSchema.safeParse({
              ...validProvenance,
              manifestHash,
            }).success,
          ).toBe(false);
        },
      );
    });

    describe('installId', () => {
      it('rejects a non-UUID string', () => {
        expect(
          PackageProvenanceSchema.safeParse({
            ...validProvenance,
            installId: 'not-a-uuid',
          }).success,
        ).toBe(false);
      });
    });

    describe('strict object', () => {
      it('rejects unknown extra fields', () => {
        expect(
          PackageProvenanceSchema.safeParse({
            ...validProvenance,
            unexpectedField: true,
          }).success,
        ).toBe(false);
      });
    });
  });

  describe('ManualMcpSchema', () => {
    it('rejects an otherwise valid input that has a package field', () => {
      const validManualInput = {
        expectedRevision: 0,
        name: 'Manual Server',
        type: 'stdio' as const,
        command: 'node',
        confirmSave: true as const,
      };

      expect(ManualMcpSchema.safeParse(validManualInput).success).toBe(true);
      expect(
        ManualMcpSchema.safeParse({
          ...validManualInput,
          package: validProvenance,
        }).success,
      ).toBe(false);
    });
  });

  describe('PackageInstallRequestSchema', () => {
    const baseInstallRequest = {
      previewId: '12345678-1234-4234-8234-123456789abc',
      entry: 'cli',
      acknowledgedWarnings: [],
      connectorName: 'my-connector',
      arguments: ['--stdio'],
    };

    it.each([
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'node_options',
      'Node_Path',
    ])('rejects env name %s', (envName) => {
      expect(
        PackageInstallRequestSchema.safeParse({
          ...baseInstallRequest,
          env: { [envName]: 'val' },
        }).success,
      ).toBe(false);
    });

    it.each([
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'OPENSSL_ENGINES',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'ssl_cert_file',
    ])('rejects the OpenSSL certificate variable %s', (envName) => {
      expect(
        PackageInstallRequestSchema.safeParse({
          ...baseInstallRequest,
          env: { [envName]: 'val' },
        }).success,
      ).toBe(false);
    });

    it.each(['OPENSSL_X', 'SSL_CERT'])('accepts %s in env', (envName) => {
      expect(
        PackageInstallRequestSchema.safeParse({
          ...baseInstallRequest,
          env: { [envName]: 'val' },
        }).success,
      ).toBe(true);
    });

    it('accepts API_TOKEN in env', () => {
      expect(
        PackageInstallRequestSchema.safeParse({
          ...baseInstallRequest,
          env: { API_TOKEN: 'placeholder-a1' },
        }).success,
      ).toBe(true);
    });

    it('defaults env to {} when omitted', () => {
      const parsed = PackageInstallRequestSchema.parse(baseInstallRequest);
      expect(parsed.env).toEqual({});
    });

    it('rejects an unknown warning code in acknowledgedWarnings', () => {
      expect(
        PackageInstallRequestSchema.safeParse({
          ...baseInstallRequest,
          acknowledgedWarnings: [
            'unknown_warning_code' as unknown as PackageWarning,
          ],
        }).success,
      ).toBe(false);
    });
  });

  describe('PackageResolveRequestSchema', () => {
    it('accepts { name }, { name, version: "latest" }, and { name, version: "1.2.3" }', () => {
      expect(
        PackageResolveRequestSchema.safeParse({ name: 'srv' }).success,
      ).toBe(true);
      expect(
        PackageResolveRequestSchema.safeParse({
          name: 'srv',
          version: 'latest',
        }).success,
      ).toBe(true);
      expect(
        PackageResolveRequestSchema.safeParse({ name: 'srv', version: '1.2.3' })
          .success,
      ).toBe(true);
    });

    it.each([
      '1.0.0-0',
      '1.0.0-alpha.1',
      '1.0.0-0a.01b',
      '1.0.0-rc.10+build.007',
    ])('accepts the exact prerelease version %s', (version) => {
      expect(
        PackageResolveRequestSchema.safeParse({ name: 'srv', version }).success,
      ).toBe(true);
    });

    it.each(['^1.2.3', 'next', '1.0.0-01', '1.0.0-alpha.007', '1.0.0-'])(
      'rejects invalid resolve version: %s',
      (version) => {
        expect(
          PackageResolveRequestSchema.safeParse({ name: 'srv', version })
            .success,
        ).toBe(false);
      },
    );
  });

  describe('PackagePreviewSchema', () => {
    const validPreview: PackagePreview = {
      previewId: '12345678-1234-4234-8234-123456789abc',
      name: 'srv',
      version: '1.2.3',
      description: 'Test preview',
      integrity: `sha512-${'a'.repeat(86)}==`,
      lockHash: 'a'.repeat(64),
      packageCount: 1,
      bundledCount: 0,
      unpackedSize: 1024,
      releasedAt: '2026-10-28T00:00:00.000Z',
      entries: [{ entry: 'cli', entryPath: 'dist/cli.js' }],
      warnings: [],
      expiresAt: '2026-10-28T00:10:00.000Z',
    };

    it('rejects an empty entries array', () => {
      expect(
        PackagePreviewSchema.safeParse({ ...validPreview, entries: [] })
          .success,
      ).toBe(false);
    });

    it('rejects packageCount: 0', () => {
      expect(
        PackagePreviewSchema.safeParse({ ...validPreview, packageCount: 0 })
          .success,
      ).toBe(false);
    });

    it('rejects extra fields such as lock', () => {
      expect(
        PackagePreviewSchema.safeParse({
          ...validPreview,
          lock: { name: 'srv', lockfileVersion: 3 },
        }).success,
      ).toBe(false);
    });
  });

  describe('PackageJobSchema', () => {
    const preview: PackagePreview = {
      previewId: '12345678-1234-4234-8234-123456789abc',
      name: 'srv',
      version: '1.2.3',
      description: 'Test preview',
      integrity: `sha512-${'a'.repeat(86)}==`,
      lockHash: 'a'.repeat(64),
      packageCount: 1,
      bundledCount: 0,
      unpackedSize: 1024,
      releasedAt: '2026-10-28T00:00:00.000Z',
      entries: [{ entry: 'cli', entryPath: 'dist/cli.js' }],
      warnings: [],
      expiresAt: '2026-10-28T00:10:00.000Z',
    };

    const completeResolveJob: PackageJob = {
      id: '12345678-1234-4234-8234-123456789abc',
      kind: 'resolve',
      state: 'succeeded',
      createdAt: '2026-10-28T00:00:00.000Z',
      completedAt: '2026-10-28T00:01:00.000Z',
      phase: 'complete',
      progress: {
        downloadedBytes: 1024,
        packages: 5,
      },
      error: null,
      preview,
      result: null,
    };

    const completeInstallJob: PackageJob = {
      id: '12345678-1234-4234-8234-123456789abc',
      kind: 'install',
      state: 'succeeded',
      createdAt: '2026-10-28T00:00:00.000Z',
      completedAt: '2026-10-28T00:02:00.000Z',
      phase: 'complete',
      progress: {
        downloadedBytes: 2048,
        packages: 10,
      },
      error: null,
      preview: null,
      result: {
        connectorId: 'srv',
        outcome: 'saved',
      },
    };

    it('accepts a complete resolve job with a preview', () => {
      expect(PackageJobSchema.parse(completeResolveJob)).toEqual(
        completeResolveJob,
      );
    });

    it('accepts a complete install job with result: { connectorId, outcome: "saved" }', () => {
      expect(PackageJobSchema.parse(completeInstallJob)).toEqual(
        completeInstallJob,
      );
    });

    it('rejects an unknown phase', () => {
      expect(
        PackageJobSchema.safeParse({
          ...completeResolveJob,
          phase: 'unknown_phase' as unknown as PackageJob['phase'],
        }).success,
      ).toBe(false);
    });

    it('rejects an unknown error code', () => {
      expect(
        PackageJobSchema.safeParse({
          ...completeResolveJob,
          error: 'unknown_error' as unknown as PackageJob['error'],
        }).success,
      ).toBe(false);
    });

    it('rejects outcome: "save_uncertain"', () => {
      expect(
        PackageJobSchema.safeParse({
          ...completeInstallJob,
          result: {
            connectorId: 'srv',
            outcome: 'save_uncertain' as unknown as 'saved',
          },
        }).success,
      ).toBe(false);
    });
  });

  describe('PackageProposalSchema', () => {
    const validProposal: PackageProposal = {
      name: 'srv',
      version: null,
      arguments: ['--stdio'],
      envNames: ['API_KEY'],
    };

    it('accepts version: null', () => {
      expect(PackageProposalSchema.parse(validProposal)).toEqual(validProposal);
    });

    it('has no field for credential values and rejects an extra env field', () => {
      expect(
        PackageProposalSchema.safeParse({
          ...validProposal,
          env: { API_KEY: 'placeholder-a2' },
        }).success,
      ).toBe(false);
    });
  });

  describe('PackageErrorCodeSchema', () => {
    it('options equals exactly the 17 codes listed in the spec Errors section', () => {
      const specErrorCodes = [
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
      ];
      expect(specErrorCodes).toHaveLength(17);
      expect([...PackageErrorCodeSchema.options].sort()).toEqual(
        [...specErrorCodes].sort(),
      );
    });
  });

  describe('CapabilityObservationSchema', () => {
    it('shape.reason accepts package_modified and invalid_configuration', () => {
      expect(
        CapabilityObservationSchema.shape.reason.safeParse('package_modified')
          .success,
      ).toBe(true);
      expect(
        CapabilityObservationSchema.shape.reason.safeParse(
          'invalid_configuration',
        ).success,
      ).toBe(true);
    });
  });
});
