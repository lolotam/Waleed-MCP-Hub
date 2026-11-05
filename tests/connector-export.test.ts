import { describe, expect, it } from 'vitest';
import type { Connector } from '@waleed/contracts';
import {
  createImportService,
  emptyState,
  exportConnectors,
} from '@waleed/hub-core';
import {
  clearImport,
  normalizeImport,
} from '../packages/hub-core/src/imports/normalize.js';

// Synthetic fixtures only. No real registry, credential or install path is
// read here, and no credential value ever reaches a fixture.
const STAMP = '2026-11-01T00:00:00.000Z';
const NODE = 'C:\\Synthetic Hub\\runtime\\node.exe';
const PACKAGES = 'C:\\Synthetic Hub\\packages';
const INSTALL_ID = '11111111-2222-4333-8444-555555555555';
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const HASH = 'a'.repeat(64);

const remote: Connector = {
  id: 'context7',
  name: 'Context7',
  description: 'Documentation lookup',
  executionMode: 'remote',
  transport: 'streamable_http',
  endpoint: 'https://example.test/mcp',
  secretBindings: {},
  headerBindings: { Authorization: 'cred-remote' },
  credentialFormats: { Authorization: 'bearer' },
  trustApproval: null,
  enabled: true,
  revision: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const native: Connector = {
  id: 'ssh-curemed-mcp',
  name: 'ssh-curemed-mcp',
  description: '',
  executionMode: 'native',
  transport: 'stdio',
  executable: 'C:\\Synthetic Tools\\ssh-mcp.exe',
  arguments: ['--host', 'example.test'],
  secretBindings: { SSH_KEY: 'cred-native' },
  headerBindings: {},
  environmentLiterals: { NO_COLOR: '1' },
  trustApproval: null,
  enabled: true,
  revision: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const docker: Connector = {
  id: 'docker-tool',
  name: 'Docker tool',
  description: '',
  executionMode: 'docker',
  transport: 'stdio',
  image: 'synthetic/image:1.2.3',
  command: ['fixture-entrypoint'],
  arguments: ['--flag'],
  portBindings: [
    { host: 8080, container: 80 },
    { host: 9090, container: 90 },
  ],
  secretBindings: {},
  headerBindings: {},
  trustApproval: null,
  enabled: true,
  revision: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const managed: Connector = {
  id: 'managed-ssh',
  name: 'Managed SSH',
  description: 'Managed package',
  executionMode: 'native',
  transport: 'stdio',
  executable: NODE,
  arguments: [
    '--no-global-search-paths',
    `${PACKAGES}\\${INSTALL_ID}\\node_modules\\ssh-mcp\\dist\\index.js`,
    '--host=example.test',
  ],
  package: {
    ecosystem: 'npm',
    name: 'ssh-mcp',
    version: '2.1.0',
    entry: 'ssh-mcp',
    entryPath: 'dist/index.js',
    installId: INSTALL_ID,
    integrity: INTEGRITY,
    lockHash: HASH,
    manifestHash: HASH,
  },
  secretBindings: { SSH_KEY: 'cred-package' },
  headerBindings: {},
  environmentLiterals: { NO_COLOR: '1' },
  trustApproval: null,
  enabled: true,
  revision: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const disabled: Connector = {
  ...native,
  id: 'disabled-tool',
  name: 'Disabled tool',
  enabled: false,
  secretBindings: {},
};

const prototypeNamed: Connector = {
  ...remote,
  id: 'proto-safe',
  name: 'constructor',
  headerBindings: {},
};

const registry = [remote, native, docker, managed, disabled, prototypeNamed];

const hubDocument = (connectors: unknown[]) => ({
  format: 'waleed-mcp-hub/connectors',
  version: 1,
  part: 1,
  parts: 1,
  connectors,
});

describe('the hub export and the hub import', () => {
  it('round trips a registry of every kind without a secret value', () => {
    const exported = exportConnectors(registry);
    expect(exported.skipped).toEqual([]);
    expect(exported.parts).toHaveLength(1);
    const text = exported.parts[0]!;
    expect(JSON.parse(text)).toMatchObject({
      format: 'waleed-mcp-hub/connectors',
      version: 1,
      part: 1,
      parts: 1,
    });
    // No credential value, no install path and no hub runtime leave the hub.
    expect(text).not.toContain('cred-');
    expect(text).not.toContain(PACKAGES);
    expect(text).not.toContain(NODE);
    expect(text).not.toContain(INSTALL_ID);

    const draft = normalizeImport(text);
    try {
      expect(draft.format).toBe('hub');
      expect(draft.entries).toHaveLength(6);
      expect(draft.secrets.size).toBe(0);
      expect(draft.references).toEqual([]);
      for (const entry of draft.entries) expect(entry.issues).toEqual([]);

      const [
        remoteEntry,
        nativeEntry,
        dockerEntry,
        packageEntry,
        disabledEntry,
        namedEntry,
      ] = draft.entries;
      expect(remoteEntry!.definition).toEqual({
        id: 'context7',
        name: 'Context7',
        description: 'Documentation lookup',
        enabled: true,
        environmentLiterals: {},
        secretBindings: {},
        headerBindings: {},
        trustApproval: null,
        executionMode: 'remote',
        transport: 'streamable_http',
        endpoint: 'https://example.test/mcp',
      });
      expect(remoteEntry!.requiredCredentials).toEqual({
        environment: [],
        header: [{ name: 'Authorization', format: 'bearer' }],
      });
      expect(remoteEntry!.warnings).toContain('credentials_required');

      expect(nativeEntry!.definition).toMatchObject({
        id: 'ssh-curemed-mcp',
        executionMode: 'native',
        executable: 'C:\\Synthetic Tools\\ssh-mcp.exe',
        arguments: ['--host', 'example.test'],
        environmentLiterals: { NO_COLOR: '1' },
        secretBindings: {},
        headerBindings: {},
      });
      expect(nativeEntry!.requiredCredentials?.environment).toEqual([
        'SSH_KEY',
      ]);

      expect(dockerEntry!.definition).toMatchObject({
        id: 'docker-tool',
        executionMode: 'docker',
        image: 'synthetic/image:1.2.3',
        command: ['fixture-entrypoint'],
        arguments: ['--flag'],
        portBindings: [
          { host: 8080, container: 80 },
          { host: 9090, container: 90 },
        ],
      });

      expect(packageEntry!.definition).toBeNull();
      expect(packageEntry!.selected).toBe(false);
      expect(packageEntry!.packageProposal).toEqual({
        name: 'ssh-mcp',
        version: '2.1.0',
        requestedVersion: null,
        arguments: ['--host=example.test'],
        envNames: ['SSH_KEY'],
        connectorName: 'Managed SSH',
        connectorId: 'managed-ssh',
        description: 'Managed package',
        entry: 'ssh-mcp',
        enabled: true,
        environmentLiterals: { NO_COLOR: '1' },
      });

      expect(disabledEntry!.definition).toMatchObject({ enabled: false });
      expect(disabledEntry!.warnings).toContain('disabled_entry');

      expect(namedEntry!.name).toBe('constructor');
      expect(namedEntry!.definition).toMatchObject({ name: 'constructor' });
    } finally {
      clearImport(draft);
    }
  });

  it('packs a large registry into parts that the importer can read', () => {
    const many = Array.from({ length: 256 }, (_, index) => ({
      ...native,
      id: `bulk-${index}`,
      name: `Bulk ${index}`,
      description: 'A synthetic connector of the bulk registry. '.repeat(4),
    }));
    const exported = exportConnectors(many);
    expect(exported.parts.length).toBeGreaterThanOrEqual(8);
    let largest = '';
    for (const part of exported.parts) {
      const document = JSON.parse(part) as {
        part: number;
        parts: number;
        connectors: unknown[];
      };
      expect(document.parts).toBe(exported.parts.length);
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(40 * 1024);
      expect(document.connectors.length).toBeLessThanOrEqual(32);
      if (part.length > largest.length) largest = part;
    }
    // The request body of the preview holds the part as a JSON string, so it
    // stays under the body limit of the hub.
    const body = JSON.stringify({ source: largest, expectedRevision: 0 });
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(64 * 1024);
  });

  it('keeps every part inside the request body limit, even for escaped text', () => {
    // A part of text that is dominated by characters JSON escapes grows when
    // it travels inside the preview request, so it must close earlier.
    const hostile = Array.from({ length: 32 }, (_, index) => ({
      ...native,
      id: `quote-${index}`,
      name: `Quote ${index}`,
      secretBindings: {},
      description: '"'.repeat(900),
      arguments: [`--flag="${'x'.repeat(200)}"`],
    }));
    const exported = exportConnectors(hostile);
    for (const part of exported.parts) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(40 * 1024);
      const body = JSON.stringify({ source: part, expectedRevision: 0 });
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(64 * 1024);
    }
    expect(exported.parts.length).toBeGreaterThan(1);
  });

  it('splits thirty-three connectors over two parts', () => {
    const many = Array.from({ length: 33 }, (_, index) => ({
      ...native,
      id: `many-${index}`,
      name: `Many ${index}`,
      secretBindings: {},
    }));
    const exported = exportConnectors(many);
    expect(exported.parts).toHaveLength(2);
    expect(
      (JSON.parse(exported.parts[0]!) as { connectors: unknown[] }).connectors,
    ).toHaveLength(32);
    expect(
      (JSON.parse(exported.parts[1]!) as { connectors: unknown[] }).connectors,
    ).toHaveLength(1);
    expect(JSON.parse(exported.parts[0]!)).toMatchObject({ part: 1, parts: 2 });
    expect(JSON.parse(exported.parts[1]!)).toMatchObject({ part: 2, parts: 2 });
  });

  it('skips a connector that no part can carry', () => {
    const huge: Connector = {
      ...native,
      id: 'huge',
      name: 'Huge',
      secretBindings: {},
      arguments: Array.from(
        { length: 40 },
        (_, index) => `argument-${index}-${'x'.repeat(4000)}`,
      ),
    };
    const exported = exportConnectors([huge, remote]);
    expect(exported.skipped).toEqual([
      { id: 'huge', name: 'Huge', reason: 'too_large' },
    ]);
    expect(exported.parts).toHaveLength(1);
    expect(
      (JSON.parse(exported.parts[0]!) as { connectors: unknown[] }).connectors,
    ).toHaveLength(1);
  });

  it('refuses a document that is not the hub format', () => {
    for (const document of [
      { ...hubDocument([remote]), version: 2 },
      { ...hubDocument([remote]), part: 2 },
      { ...hubDocument([remote]), part: 1.5 },
      { ...hubDocument([]) },
      { ...hubDocument(Array.from({ length: 33 }, () => remote)) },
    ]) {
      expect(() => normalizeImport(JSON.stringify(document))).toThrow();
    }
  });

  it('refuses credential names the Authentication dialog refuses', () => {
    const draft = normalizeImport(
      JSON.stringify(
        hubDocument([
          {
            id: 'forbidden-environment',
            name: 'Forbidden environment',
            description: '',
            enabled: true,
            executionMode: 'native',
            executable: 'tool',
            arguments: [],
            environmentCredentials: ['NODE_OPTIONS'],
          },
          {
            id: 'forbidden-header',
            name: 'Forbidden header',
            description: '',
            enabled: true,
            executionMode: 'remote',
            transport: 'streamable_http',
            endpoint: 'https://example.test/mcp',
            headerCredentials: [{ name: 'Host', format: 'raw' }],
          },
          {
            id: 'duplicate-names',
            name: 'Duplicate names',
            description: '',
            enabled: true,
            executionMode: 'native',
            executable: 'tool',
            arguments: [],
            environmentCredentials: ['TOKEN', 'token'],
          },
          {
            id: 'literal-collision',
            name: 'Literal collision',
            description: '',
            enabled: true,
            executionMode: 'native',
            executable: 'tool',
            arguments: [],
            environmentLiterals: { NO_COLOR: '1' },
            environmentCredentials: ['NO_COLOR'],
          },
        ]),
      ),
    );
    try {
      expect(draft.entries[0]!.issues).toContainEqual({
        code: 'invalid_bindings',
        field: 'environment',
      });
      expect(draft.entries[1]!.issues).toContainEqual({
        code: 'invalid_bindings',
        field: 'header',
      });
      expect(draft.entries[2]!.issues).toContainEqual({
        code: 'invalid_bindings',
        field: 'environment',
      });
      expect(draft.entries[3]!.issues).toContainEqual({
        code: 'invalid_bindings',
        field: 'environment',
      });
      // No value is ever captured, not even for a refused name.
      expect(draft.secrets.size).toBe(0);
      expect(draft.references).toEqual([]);
    } finally {
      clearImport(draft);
    }
  });

  it('deselects the entries that are installed, for the hub format only', () => {
    const service = createImportService();
    const state = emptyState();
    state.connectors.push({
      ...native,
      id: 'ssh-curemed-mcp',
      name: 'A different name',
      secretBindings: {},
    });
    state.connectors.push({
      ...remote,
      id: 'other-id',
      name: 'CONTEXT7',
      headerBindings: {},
    });
    const exported = exportConnectors([remote, native, managed]);
    const preview = service.preview(
      { source: exported.parts[0]!, expectedRevision: 0 },
      'owner',
      state,
      false,
    );
    expect(preview.format).toBe('hub');
    const byId = (id: string) =>
      preview.entries.find((entry) => entry.id === id);
    // The id of the installed connector and the folded name of the other one.
    expect(byId('ssh-curemed-mcp')!.selected).toBe(false);
    expect(byId('context7')!.selected).toBe(false);
    // The proposal of a connector that is not installed stays untouched.
    expect(byId('managed-ssh')!.warnings).not.toContain('already_installed');

    const other = service.preview(
      {
        source: JSON.stringify({
          mcpServers: { tool: { command: 'tool' } },
        }),
        expectedRevision: 0,
      },
      'owner',
      state,
      false,
    );
    expect(other.format).toBe('mcpServers');
    expect(other.entries[0]!.selected).toBe(true);
    service.close();
  });

  // PR #26 review: a managed package's own "-c" argument was refused as an
  // npx inline program, so its export could not be imported again.
  it('round trips a package connector whose arguments start with -c', () => {
    const configured: Connector = {
      ...managed,
      arguments: [...managed.arguments!.slice(0, 2), '-c', 'config.json'],
    };
    const draft = normalizeImport(exportConnectors([configured]).parts[0]!);
    try {
      expect(draft.entries[0]!.issues).toEqual([]);
      expect(draft.entries[0]!.packageProposal?.arguments).toEqual([
        '-c',
        'config.json',
      ]);
    } finally {
      clearImport(draft);
    }
  });

  it('refuses unknown fields inside a header credential or a package', () => {
    const exported = JSON.parse(
      exportConnectors([remote, managed]).parts[0]!,
    ) as { connectors: Record<string, unknown>[] };
    const [hubRemote, hubManaged] = exported.connectors;
    const draft = normalizeImport(
      JSON.stringify(
        hubDocument([
          {
            ...hubRemote,
            headerCredentials: [
              { name: 'Authorization', format: 'bearer', value: 'x' },
            ],
          },
          {
            ...hubManaged,
            package: {
              ...(hubManaged!.package as object),
              integrity: 'sha512-x',
            },
          },
        ]),
      ),
    );
    try {
      expect(draft.entries[0]!.issues).toContainEqual({
        code: 'invalid_bindings',
        field: 'header',
      });
      expect(draft.entries[1]!.issues).toContainEqual({
        code: 'unsupported_fields',
        field: 'package',
      });
    } finally {
      clearImport(draft);
    }
  });

  it('marks the proposal of an installed package connector', () => {
    const service = createImportService();
    const state = emptyState();
    state.connectors.push({
      ...managed,
      id: 'managed-ssh',
      secretBindings: {},
    });
    const exported = exportConnectors([managed]);
    const preview = service.preview(
      { source: exported.parts[0]!, expectedRevision: 0 },
      'owner',
      state,
      false,
    );
    expect(preview.entries[0]!.warnings).toContain('already_installed');
    service.close();
  });
});
