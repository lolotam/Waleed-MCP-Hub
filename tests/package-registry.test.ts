import { afterEach, describe, expect, it } from 'vitest';
import type {
  Connector,
  HubState,
  ImportDefinition,
  PackageProvenance,
} from '@waleed/contracts';
import {
  createLifecycle,
  createMemorySafetyLedger,
  emptyState,
} from '@waleed/hub-core';
import {
  NO_GLOBAL_SEARCH_PATHS,
  definitionHash,
  hashData,
  isPackageEnvName,
  packageArguments,
  packageEntryFile,
  packagesDirOf,
  planPackageReplace,
  planRegistry,
} from '../packages/hub-core/src/runtime/registry.js';
import { syntheticConnector } from './fixtures/native-connector.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';

type NativeConnector = Extract<Connector, { executionMode: 'native' }>;
type NativeImportDefinition = Extract<
  ImportDefinition,
  { executionMode: 'native' }
>;

function asNative(connector: Connector | undefined): NativeConnector {
  if (!connector || connector.executionMode !== 'native') {
    throw new Error('Expected native connector');
  }
  return connector;
}

const nodeExecutable = 'C:\\Hub\\runtime\\node.exe';
const packagesDir = 'D:\\HubData\\packages';
const timestamp = '2026-10-28T00:00:00.000Z';

const validPackage: PackageProvenance = {
  ecosystem: 'npm',
  name: '@scope/srv',
  version: '1.2.3',
  entry: 'srv',
  entryPath: 'dist/cli.js',
  installId: '12345678-1234-4234-8234-123456789abc',
  integrity: `sha512-${'A'.repeat(86)}==`,
  lockHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64),
};

function createManagedConnector(
  overrides: Partial<NativeConnector> = {},
): NativeConnector {
  return {
    id: 'pkg-connector',
    name: 'Package Connector',
    description: 'Managed MCP connector',
    executionMode: 'native',
    transport: 'stdio',
    executable: nodeExecutable,
    arguments: packageArguments(packagesDir, validPackage, ['--port', '8080']),
    package: validPackage,
    environmentLiterals: {},
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
    enabled: true,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createManagedImportDefinition(
  overrides: Partial<NativeImportDefinition> = {},
): NativeImportDefinition {
  return {
    id: 'pkg-connector',
    name: 'Package Connector',
    description: 'Managed MCP connector',
    executionMode: 'native',
    transport: 'stdio',
    executable: nodeExecutable,
    arguments: packageArguments(packagesDir, validPackage, ['--port', '8080']),
    package: validPackage,
    environmentLiterals: {},
    secretBindings: {},
    headerBindings: {},
    enabled: true,
    trustApproval: null,
    ...overrides,
  };
}

const memories: ReturnType<typeof memorySecrets>[] = [];
afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
});

describe('F01 T2: registry and approval of managed npm packages', () => {
  describe('1. Layout', () => {
    it('packageEntryFile builds the canonical path under packagesDir', () => {
      const entryFile = packageEntryFile(packagesDir, validPackage);
      expect(entryFile).toBe(
        'D:\\HubData\\packages\\12345678-1234-4234-8234-123456789abc\\node_modules\\@scope\\srv\\dist\\cli.js',
      );
    });

    it('packageArguments prepends --no-global-search-paths and the entry file', () => {
      expect(NO_GLOBAL_SEARCH_PATHS).toBe('--no-global-search-paths');
      const userArgs = ['--flag', 'value'];
      const args = packageArguments(packagesDir, validPackage, userArgs);
      expect(args).toEqual([
        NO_GLOBAL_SEARCH_PATHS,
        'D:\\HubData\\packages\\12345678-1234-4234-8234-123456789abc\\node_modules\\@scope\\srv\\dist\\cli.js',
        '--flag',
        'value',
      ]);
    });

    it('packagesDirOf inverts packageEntryFile and returns null on any mismatch', () => {
      const entryFile = packageEntryFile(packagesDir, validPackage);
      expect(packagesDirOf(entryFile, validPackage)).toBe(packagesDir);

      const foreignInstallId = '87654321-4321-4321-8321-cba987654321';
      const foreignInstallEntry = packageEntryFile(packagesDir, {
        ...validPackage,
        installId: foreignInstallId,
      });
      expect(packagesDirOf(foreignInstallEntry, validPackage)).toBeNull();

      const foreignNameEntry = packageEntryFile(packagesDir, {
        ...validPackage,
        name: '@scope/other',
      });
      expect(packagesDirOf(foreignNameEntry, validPackage)).toBeNull();

      const foreignPathEntry = packageEntryFile(packagesDir, {
        ...validPackage,
        entryPath: 'dist/other.js',
      });
      expect(packagesDirOf(foreignPathEntry, validPackage)).toBeNull();

      expect(packagesDirOf('C:\\arbitrary\\file.js', validPackage)).toBeNull();
    });
  });

  describe('2. Hashing', () => {
    it('native connector without package has the same definitionHash as the legacy executionDefinition shape', () => {
      const synthetic = asNative(syntheticConnector);
      const legacyExecutionDefinition = {
        executionMode: synthetic.executionMode,
        transport: synthetic.transport,
        environmentLiterals: synthetic.environmentLiterals ?? {},
        secretBindings: synthetic.secretBindings,
        headerBindings: synthetic.headerBindings,
        executable: synthetic.executable,
        arguments: synthetic.arguments,
      };
      expect(definitionHash(syntheticConnector)).toBe(
        hashData(legacyExecutionDefinition),
      );
    });

    it('changing each one of the nine provenance fields changes the definitionHash', () => {
      const baseConnector = createManagedConnector();
      const baseHash = definitionHash(baseConnector);

      const fieldMutations: Array<[keyof PackageProvenance, unknown]> = [
        ['ecosystem', 'npm-custom' as const],
        ['name', '@scope/other'],
        ['version', '1.2.4'],
        ['entry', 'srv2'],
        ['entryPath', 'dist/other.js'],
        ['installId', '87654321-4321-4321-8321-cba987654321'],
        ['integrity', `sha512-${'B'.repeat(86)}==`],
        ['lockHash', 'c'.repeat(64)],
        ['manifestHash', 'd'.repeat(64)],
      ];

      expect(fieldMutations).toHaveLength(9);

      for (const [field, mutatedValue] of fieldMutations) {
        const mutatedConnector: Connector = {
          ...baseConnector,
          package: {
            ...validPackage,
            [field]: mutatedValue,
          } as PackageProvenance,
        };
        const mutatedHash = definitionHash(mutatedConnector);
        expect(mutatedHash).not.toBe(baseHash);
      }
    });
  });

  describe('3. create_connector with package', () => {
    it('refuses creation when context is missing', () => {
      const state = emptyState();
      const def = createManagedImportDefinition();
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: def,
          },
          state,
          def.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses creation when trusted context package differs in any field', () => {
      const state = emptyState();
      const def = createManagedImportDefinition();
      const context = {
        trustedPackage: { ...validPackage, version: '1.2.4' },
        nodeExecutable,
        packagesDir,
      };
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: def,
          },
          state,
          def.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses creation when executable does not match hub runtime in context', () => {
      const state = emptyState();
      const def = createManagedImportDefinition({
        executable: 'C:\\Other\\node.exe',
      });
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: def,
          },
          state,
          def.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses creation when first argument is missing or different', () => {
      const state = emptyState();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };

      const missingFlag = createManagedImportDefinition({
        arguments: [packageEntryFile(packagesDir, validPackage)],
      });
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: missingFlag,
          },
          state,
          missingFlag.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));

      const wrongFlag = createManagedImportDefinition({
        arguments: [
          '--unexpected-flag',
          packageEntryFile(packagesDir, validPackage),
        ],
      });
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: wrongFlag,
          },
          state,
          wrongFlag.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses creation when entry argument belongs to a different installId', () => {
      const state = emptyState();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };
      const foreignEntry = packageEntryFile(packagesDir, {
        ...validPackage,
        installId: '87654321-4321-4321-8321-cba987654321',
      });
      const def = createManagedImportDefinition({
        arguments: [NO_GLOBAL_SEARCH_PATHS, foreignEntry, '--port', '8080'],
      });
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: def,
          },
          state,
          def.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('saves connector with package, executable and both fixed arguments when everything matches', () => {
      const state = emptyState();
      const def = createManagedImportDefinition();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };
      const plan = planRegistry(
        {
          kind: 'create_connector',
          expectedRevision: state.revision,
          definition: def,
        },
        state,
        def.id,
        timestamp,
        context,
      );

      expect(plan.next.connectors).toHaveLength(1);
      const saved = asNative(plan.next.connectors[0]);
      expect(saved.id).toBe(def.id);
      expect(saved.package).toEqual(validPackage);
      expect(saved.executable).toBe(nodeExecutable);
      expect(saved.arguments).toEqual(
        packageArguments(packagesDir, validPackage, ['--port', '8080']),
      );
      expect(saved.revision).toBe(1);
      expect(saved.trustApproval).toBeNull();
      expect(plan.affectedConnectors).toContain(def.id);
    });
  });

  describe('4. create_connectors bulk operation', () => {
    it('refuses create_connectors with one definition carrying package, even with trusted context', () => {
      const state = emptyState();
      const def = createManagedImportDefinition();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };
      expect(() =>
        planRegistry(
          {
            kind: 'create_connectors',
            expectedRevision: state.revision,
            definitions: [def],
          },
          state,
          def.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });
  });

  describe('5. edit_connector on stored managed connector', () => {
    function setupStoredManagedState(): {
      state: HubState;
      stored: NativeConnector;
    } {
      const state = emptyState();
      const stored = createManagedConnector();
      state.connectors.push(stored);
      state.revision = 0;
      return { state, stored };
    }

    it('omits package and changes only name: saved with package, executable and fixed arguments intact', () => {
      const { state, stored } = setupStoredManagedState();
      const editDef: NativeImportDefinition = {
        id: stored.id,
        name: 'Renamed Package Server',
        description: stored.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: stored.executable,
        arguments: [
          ...stored.arguments.slice(0, 2),
          '--port',
          '9090',
          '--verbose',
        ],
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };

      const plan = planRegistry(
        {
          kind: 'edit_connector',
          connectorId: stored.id,
          expectedRevision: state.revision,
          definition: editDef,
        },
        state,
        stored.id,
        timestamp,
      );

      const saved = asNative(
        plan.next.connectors.find((c) => c.id === stored.id),
      );
      expect(saved.name).toBe('Renamed Package Server');
      expect(saved.package).toEqual(validPackage);
      expect(saved.executable).toBe(nodeExecutable);
      expect(saved.arguments.slice(0, 2)).toEqual(stored.arguments.slice(0, 2));
      expect(saved.arguments.slice(2)).toEqual(['--port', '9090', '--verbose']);
      expect(saved.revision).toBe(2);
      expect(saved.trustApproval).toBeNull();
    });

    it('refuses edit when package is supplied (even identical)', () => {
      const { state, stored } = setupStoredManagedState();
      const editDef: NativeImportDefinition = {
        id: stored.id,
        name: 'Changed Name',
        description: stored.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: stored.executable,
        arguments: stored.arguments,
        package: validPackage,
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };

      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: stored.id,
            expectedRevision: state.revision,
            definition: editDef,
          },
          state,
          stored.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses edit that changes executionMode to remote', () => {
      const { state, stored } = setupStoredManagedState();
      const editDef = {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        executionMode: 'remote' as const,
        transport: 'sse' as const,
        endpoint: 'https://example.test/mcp',
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };

      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: stored.id,
            expectedRevision: state.revision,
            definition: editDef,
          },
          state,
          stored.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses edit that changes executable', () => {
      const { state, stored } = setupStoredManagedState();
      const editDef: NativeImportDefinition = {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: 'C:\\Other\\node.exe',
        arguments: stored.arguments,
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };

      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: stored.id,
            expectedRevision: state.revision,
            definition: editDef,
          },
          state,
          stored.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses edit that changes argument 0 or argument 1', () => {
      const { state, stored } = setupStoredManagedState();

      const changedArg0: NativeImportDefinition = {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: stored.executable,
        arguments: ['--altered-flag', stored.arguments[1]!, '--port', '8080'],
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };
      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: stored.id,
            expectedRevision: state.revision,
            definition: changedArg0,
          },
          state,
          stored.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));

      const changedArg1: NativeImportDefinition = {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: stored.executable,
        arguments: [
          stored.arguments[0]!,
          'D:\\HubData\\packages\\other\\entry.js',
          '--port',
          '8080',
        ],
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };
      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: stored.id,
            expectedRevision: state.revision,
            definition: changedArg1,
          },
          state,
          stored.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });
  });

  describe('6. edit_connector on stored unmanaged native connector', () => {
    function setupStoredUnmanagedState(): {
      state: HubState;
      stored: NativeConnector;
    } {
      const state = emptyState();
      const stored = structuredClone(asNative(syntheticConnector));
      state.connectors.push(stored);
      state.revision = 0;
      return { state, stored };
    }

    it('refuses edit that supplies a package', () => {
      const { state, stored } = setupStoredUnmanagedState();
      const editWithPkg: NativeImportDefinition = {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: stored.executable,
        arguments: stored.arguments,
        package: validPackage,
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };

      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: stored.id,
            expectedRevision: state.revision,
            definition: editWithPkg,
          },
          state,
          stored.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('allows an ordinary edit without package as before', () => {
      const { state, stored } = setupStoredUnmanagedState();
      const ordinaryEdit: NativeImportDefinition = {
        id: stored.id,
        name: 'Renamed Native MCP',
        description: 'Updated synthetic description',
        executionMode: 'native',
        transport: 'stdio',
        executable: stored.executable,
        arguments: ['--new-synthetic-arg', 'value'],
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };

      const plan = planRegistry(
        {
          kind: 'edit_connector',
          connectorId: stored.id,
          expectedRevision: state.revision,
          definition: ordinaryEdit,
        },
        state,
        stored.id,
        timestamp,
      );

      const saved = asNative(
        plan.next.connectors.find((c) => c.id === stored.id),
      );
      expect(saved.name).toBe('Renamed Native MCP');
      expect(saved.arguments).toEqual(['--new-synthetic-arg', 'value']);
      expect(saved.package).toBeUndefined();
      expect(saved.revision).toBe(stored.revision + 1);
    });
  });

  describe('7. User arguments on package connector', () => {
    it('accepts [-p, 8080] and [-e] after the entry script', () => {
      const state = emptyState();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };

      const defPort = createManagedImportDefinition({
        id: 'pkg-conn-port',
        arguments: packageArguments(packagesDir, validPackage, ['-p', '8080']),
      });
      const planPort = planRegistry(
        {
          kind: 'create_connector',
          expectedRevision: state.revision,
          definition: defPort,
        },
        state,
        defPort.id,
        timestamp,
        context,
      );
      const savedPort = asNative(planPort.next.connectors[0]);
      expect(savedPort.arguments.slice(2)).toEqual(['-p', '8080']);

      const defEval = createManagedImportDefinition({
        id: 'pkg-conn-eval',
        arguments: packageArguments(packagesDir, validPackage, ['-e']),
      });
      const planEval = planRegistry(
        {
          kind: 'create_connector',
          expectedRevision: state.revision,
          definition: defEval,
        },
        state,
        defEval.id,
        timestamp,
        context,
      );
      const savedEval = asNative(planEval.next.connectors[0]);
      expect(savedEval.arguments.slice(2)).toEqual(['-e']);
    });

    it('refuses [--token=placeholder] due to embedded credential pattern', () => {
      const state = emptyState();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };

      const defToken = createManagedImportDefinition({
        arguments: packageArguments(packagesDir, validPackage, [
          '--token=placeholder',
        ]),
      });
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: defToken,
          },
          state,
          defToken.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });
  });

  describe('8. NODE_ names on package connectors vs unmanaged connectors', () => {
    it('isPackageEnvName identifies NODE_ prefixed names case-insensitively', () => {
      expect(isPackageEnvName('NODE_OPTIONS')).toBe(true);
      expect(isPackageEnvName('node_extra_ca_certs')).toBe(true);
      expect(isPackageEnvName('Node_Path')).toBe(true);
      expect(isPackageEnvName('NODE_ENV')).toBe(true);
      expect(isPackageEnvName('PROVIDER_TOKEN')).toBe(false);
      expect(isPackageEnvName('API_KEY')).toBe(false);
    });

    it('isPackageEnvName identifies the OpenSSL certificate variables', () => {
      expect(isPackageEnvName('OPENSSL_CONF')).toBe(true);
      expect(isPackageEnvName('OPENSSL_MODULES')).toBe(true);
      expect(isPackageEnvName('OPENSSL_ENGINES')).toBe(true);
      expect(isPackageEnvName('SSL_CERT_FILE')).toBe(true);
      expect(isPackageEnvName('SSL_CERT_DIR')).toBe(true);
      expect(isPackageEnvName('ssl_cert_file')).toBe(true);
      expect(isPackageEnvName('OpenSSL_Conf')).toBe(true);
      expect(isPackageEnvName('OPENSSL_X')).toBe(false);
      expect(isPackageEnvName('SSL_CERT')).toBe(false);
    });

    it('package connector refuses environment literals starting with NODE_ (uppercase and lowercase)', () => {
      const state = emptyState();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };

      const defUpper = createManagedImportDefinition({
        environmentLiterals: { NODE_OPTIONS: '--inspect' },
      });
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: defUpper,
          },
          state,
          defUpper.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));

      const defLower = createManagedImportDefinition({
        environmentLiterals: { node_extra_ca_certs: 'C:\\trusted.crt' },
      });
      expect(() =>
        planRegistry(
          {
            kind: 'create_connector',
            expectedRevision: state.revision,
            definition: defLower,
          },
          state,
          defLower.id,
          timestamp,
          context,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('package connector refuses the OpenSSL certificate variables', () => {
      const state = emptyState();
      const context = {
        trustedPackage: validPackage,
        nodeExecutable,
        packagesDir,
      };

      for (const name of [
        'OPENSSL_CONF',
        'OPENSSL_MODULES',
        'OPENSSL_ENGINES',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
      ]) {
        const definition = createManagedImportDefinition({
          environmentLiterals: { [name]: 'C:\\trusted.pem' },
        });
        expect(() =>
          planRegistry(
            {
              kind: 'create_connector',
              expectedRevision: state.revision,
              definition,
            },
            state,
            definition.id,
            timestamp,
            context,
          ),
        ).toThrow(expect.objectContaining({ code: 'invalid' }));
      }
    });

    it('unmanaged native connector keeps existing literal behaviour: rejects literals not in allowlist', () => {
      const state = emptyState();
      const synthetic = asNative(syntheticConnector);
      state.connectors.push(synthetic);
      state.revision = 0;

      // On unmanaged native connectors, environment literals are checked against literalValues
      // in normalize.ts (NODE_ENV, NO_COLOR, CHROME_DEVTOOLS_MCP_*).
      // NODE_OPTIONS and node_extra_ca_certs are not in literalValues, so both reject with HubError 'invalid'.
      const editOptions: NativeImportDefinition = {
        id: synthetic.id,
        name: synthetic.name,
        description: synthetic.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: synthetic.executable,
        arguments: synthetic.arguments,
        environmentLiterals: { NODE_OPTIONS: '--inspect' },
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };
      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: synthetic.id,
            expectedRevision: state.revision,
            definition: editOptions,
          },
          state,
          synthetic.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));

      const editCerts: NativeImportDefinition = {
        id: synthetic.id,
        name: synthetic.name,
        description: synthetic.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: synthetic.executable,
        arguments: synthetic.arguments,
        environmentLiterals: { node_extra_ca_certs: 'C:\\trusted.crt' },
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };
      expect(() =>
        planRegistry(
          {
            kind: 'edit_connector',
            connectorId: synthetic.id,
            expectedRevision: state.revision,
            definition: editCerts,
          },
          state,
          synthetic.id,
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));

      // By contrast, NODE_ENV is in literalValues, so it is accepted on unmanaged connectors:
      const editNodeEnv: NativeImportDefinition = {
        id: synthetic.id,
        name: synthetic.name,
        description: synthetic.description,
        executionMode: 'native',
        transport: 'stdio',
        executable: synthetic.executable,
        arguments: synthetic.arguments,
        environmentLiterals: { NODE_ENV: 'production' },
        secretBindings: {},
        headerBindings: {},
        enabled: true,
        trustApproval: null,
      };
      const plan = planRegistry(
        {
          kind: 'edit_connector',
          connectorId: synthetic.id,
          expectedRevision: state.revision,
          definition: editNodeEnv,
        },
        state,
        synthetic.id,
        timestamp,
      );
      const savedNodeEnv = asNative(plan.next.connectors[0]);
      expect(savedNodeEnv.environmentLiterals).toEqual({
        NODE_ENV: 'production',
      });
    });
  });

  describe('9. Credential API integration', () => {
    function setupCredentialHarness(connector: Connector) {
      const state = emptyState();
      state.connectors = [structuredClone(connector)];
      state.revision = 0;
      const store = memoryStore(state);
      const secrets = memorySecrets();
      memories.push(secrets);
      const safety = createMemorySafetyLedger();
      const hub = createLifecycle(store, Date.now, safety, {
        secrets: { windows: secrets.backend, docker: secrets.backend },
      });
      return { hub, store, secrets, safety };
    }

    it('rejects NODE_EXTRA_CA_CERTS on managed connector without storing secrets or altering state', async () => {
      const managedConnector = createManagedConnector();
      const { hub, secrets } = setupCredentialHarness(managedConnector);

      const writeCaInput = {
        expectedRevision: 0,
        expectedConnectorRevision: 1,
        location: 'environment' as const,
        name: 'NODE_EXTRA_CA_CERTS',
        format: 'raw' as const,
        adapter: 'windows' as const,
        value: 'C:\\certs\\corporate-root.pem',
      };

      await expect(
        hub.auth.credentials.write(managedConnector.id, writeCaInput),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'invalid',
          // The refusal names the OpenSSL variables as well: it is the same
          // wording as the one of the registry.
          message:
            'Environment names starting with NODE_ and the OpenSSL certificate variables are refused on package connectors.',
        }),
      );

      expect(secrets.writes).toHaveLength(0);
      expect(secrets.values.size).toBe(0);

      const inventory = await hub.inventory();
      expect(inventory.revision).toBe(0);
      const current = asNative(inventory.connectors[0]);
      expect(current.revision).toBe(1);
      expect(current.secretBindings).toEqual({});

      // Writing PROVIDER_TOKEN on the same managed connector succeeds:
      const writeTokenInput = {
        expectedRevision: 0,
        expectedConnectorRevision: 1,
        location: 'environment' as const,
        name: 'PROVIDER_TOKEN',
        format: 'raw' as const,
        adapter: 'windows' as const,
        value: 'SYNTHETIC-managed-token-value',
      };
      const receipt = await hub.auth.credentials.write(
        managedConnector.id,
        writeTokenInput,
      );
      expect(receipt.present).toBe(true);
      expect(receipt.revision).toBe(2);

      const updatedInventory = await hub.inventory();
      expect(updatedInventory.revision).toBe(1);
      const updatedConnector = asNative(updatedInventory.connectors[0]);
      expect(updatedConnector.revision).toBe(2);
      expect(updatedConnector.secretBindings).toHaveProperty('PROVIDER_TOKEN');
      expect(secrets.values.size).toBe(1);

      await hub.close();
    });

    it('on unmanaged native connector, NODE_EXTRA_CA_CERTS succeeds under current code', async () => {
      const { hub, secrets } = setupCredentialHarness(syntheticConnector);

      // In current code, bindings.ts forbiddenEnvironment blocks NODE_OPTIONS and NODE_PATH,
      // but NOT NODE_EXTRA_CA_CERTS. Because an unmanaged connector has no package property,
      // the package check is bypassed and the write succeeds.
      const writeInput = {
        expectedRevision: 0,
        expectedConnectorRevision: 1,
        location: 'environment' as const,
        name: 'NODE_EXTRA_CA_CERTS',
        format: 'raw' as const,
        adapter: 'windows' as const,
        value: 'C:\\certs\\unmanaged-ca.pem',
      };

      const receipt = await hub.auth.credentials.write(
        syntheticConnector.id,
        writeInput,
      );
      expect(receipt.present).toBe(true);
      expect(receipt.revision).toBe(2);

      const inventory = await hub.inventory();
      expect(inventory.revision).toBe(1);
      const current = asNative(inventory.connectors[0]);
      expect(current.revision).toBe(2);
      expect(current.secretBindings).toHaveProperty('NODE_EXTRA_CA_CERTS');
      expect(secrets.values.size).toBe(1);

      await hub.close();
    });
  });

  describe('10. planPackageReplace', () => {
    const newPackage: PackageProvenance = {
      ...validPackage,
      version: '2.0.0',
      integrity: `sha512-${'B'.repeat(86)}==`,
      lockHash: 'c'.repeat(64),
      manifestHash: 'd'.repeat(64),
    };
    const newNodeExecutable = 'C:\\Hub\\runtime\\node-v24.exe';
    const newPackagesDir = 'D:\\HubData\\packages_v2';

    it('refuses replace on an unmanaged connector without package', () => {
      const state = emptyState();
      state.connectors.push(syntheticConnector);
      expect(() =>
        planPackageReplace(
          state,
          {
            connectorId: syntheticConnector.id,
            expectedConnectorRevision: syntheticConnector.revision,
            package: newPackage,
            nodeExecutable: newNodeExecutable,
            packagesDir: newPackagesDir,
          },
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));
    });

    it('refuses replace with conflict on stale expectedConnectorRevision and does not mutate input state', () => {
      const state = emptyState();
      const managed = createManagedConnector({ revision: 3 });
      state.connectors.push(managed);
      state.revision = 2;
      const stateSnapshot = structuredClone(state);

      expect(() =>
        planPackageReplace(
          state,
          {
            connectorId: managed.id,
            expectedConnectorRevision: 2, // stale; actual is 3
            package: newPackage,
            nodeExecutable: newNodeExecutable,
            packagesDir: newPackagesDir,
          },
          timestamp,
        ),
      ).toThrow(expect.objectContaining({ code: 'conflict' }));

      expect(state).toEqual(stateSnapshot);
    });

    it('updates package, executable, fixed arguments; preserves user arguments, environment literals, secret bindings, profile membership; increments revisions; resets trustApproval', () => {
      const state = emptyState();
      const originalApproval = {
        revision: 1,
        approvedAt: timestamp,
        definitionHash: definitionHash(createManagedConnector()),
        risk: 'native_execution' as const,
      };
      const managed = createManagedConnector({
        revision: 1,
        arguments: packageArguments(packagesDir, validPackage, [
          '--user-flag',
          'user-value',
        ]),
        environmentLiterals: { CUSTOM_LITERAL: 'constant' },
        secretBindings: { SECRET_TOKEN: 'ref-sample-1' },
        trustApproval: originalApproval,
      });
      state.connectors.push(managed);
      state.secretReferences.push({
        id: 'ref-sample-1',
        adapter: 'windows',
        present: true,
        ownerIds: [managed.id],
      });
      state.profiles.push({
        id: 'profile-a',
        name: 'Profile A',
        description: 'Contains managed package connector',
        connectorIds: [managed.id],
        revision: 1,
        dockerProfileId: null,
        updatedAt: timestamp,
      });
      const initialRevision = state.revision;

      const plan = planPackageReplace(
        state,
        {
          connectorId: managed.id,
          expectedConnectorRevision: 1,
          package: newPackage,
          nodeExecutable: newNodeExecutable,
          packagesDir: newPackagesDir,
        },
        timestamp,
      );

      const replaced = asNative(
        plan.next.connectors.find((c) => c.id === managed.id),
      );
      expect(replaced.package).toEqual(newPackage);
      expect(replaced.executable).toBe(newNodeExecutable);
      expect(replaced.arguments[0]).toBe(NO_GLOBAL_SEARCH_PATHS);
      expect(replaced.arguments[1]).toBe(
        packageEntryFile(newPackagesDir, newPackage),
      );
      expect(replaced.arguments.slice(2)).toEqual([
        '--user-flag',
        'user-value',
      ]);
      expect(replaced.environmentLiterals).toEqual({
        CUSTOM_LITERAL: 'constant',
      });
      expect(replaced.secretBindings).toEqual({ SECRET_TOKEN: 'ref-sample-1' });
      expect(replaced.revision).toBe(2);
      expect(replaced.trustApproval).toBeNull();
      expect(plan.next.revision).toBe(initialRevision + 1);

      expect(plan.next.profiles[0]!.connectorIds).toContain(managed.id);
      expect(plan.affectedProfiles).toContain('profile-a');
      expect(plan.affectedConnectors).toContain(managed.id);
    });
  });
});
