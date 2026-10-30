import { describe, expect, it, vi } from 'vitest';
import { ImportDefinitionSchema } from '@waleed/contracts';
import {
  normalizeImport,
  clearImport,
} from '../packages/hub-core/src/imports/normalize.js';
import { importSecret, mixedImport } from './fixtures/imports.js';

function normalize(value: unknown) {
  return normalizeImport(JSON.stringify(value));
}
function entry(value: unknown) {
  const draft = normalize(value);
  try {
    return draft.entries[0]!;
  } finally {
    clearImport(draft);
  }
}

describe('deterministic data-only import normalization', () => {
  it.each(['userinfo', 'query'])(
    'does not expose rejected %s URL credentials indirectly in a name or another entry',
    (kind) => {
      const url =
        kind === 'userinfo'
          ? `https://user:${importSecret}@example.test/mcp`
          : `https://example.test/mcp?token=${importSecret}`;
      const draft = normalize({
        servers: {
          One: { name: url, url },
          Two: { name: importSecret, command: 'tool' },
        },
      });
      expect(JSON.stringify(draft.entries)).not.toContain(importSecret);
      expect(draft.entries.every((entry) => entry.definition === null)).toBe(
        true,
      );
      clearImport(draft);
    },
  );
  it.each([
    { command: 'tool', args: null },
    { command: 'tool', name: null },
    { command: 'tool', description: null },
    { url: 'https://example.test', transport: null },
    { remote: { url: 'https://example.test', transport_type: null } },
  ])(
    'rejects explicit malformed null fields rather than silently defaulting them: %j',
    (input) => {
      const result = entry(input);
      expect(result.definition).toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
    },
  );
  it('keeps tool version arguments from falsely pinning an unpinned package', () => {
    expect(
      entry({
        command: 'npx',
        args: ['synthetic@latest', '--other', 'other@1.2.3'],
      }).warnings,
    ).toContain('unpinned_package');
    expect(
      entry({ command: 'uvx', args: ['synthetic', '--other', 'other==1.2.3'] })
        .warnings,
    ).toContain('unpinned_package');
    expect(
      entry({ command: 'npx', args: ['--yes', '@scope/synthetic@1.2.3'] })
        .warnings,
    ).not.toContain('unpinned_package');
  });
  it('does not expose a private value via a separately declared environment literal', () => {
    expect(
      entry({
        command: 'tool',
        env: { PRIVATE: 'production' },
        environmentLiterals: { NODE_ENV: 'production' },
      }).definition,
    ).toBeNull();
  });
  it('bounds individual arguments, bindings, and total extracted secrets, zeroing partial buffers on failure', () => {
    expect(
      entry({ command: ['tool', ...Array.from({ length: 128 }, () => 'arg')] })
        .issues,
    ).toEqual([]);
    expect(
      entry({ command: 'tool', args: Array.from({ length: 129 }, () => 'arg') })
        .definition,
    ).toBeNull();
    expect(
      entry({ command: 'tool', args: ['x'.repeat(4097)] }).definition,
    ).toBeNull();
    expect(
      entry({
        command: 'tool',
        env: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [
            `KEY_${index}`,
            importSecret,
          ]),
        ),
      }).definition,
    ).toBeNull();
    const from = vi.spyOn(Buffer, 'from');
    try {
      expect(() =>
        normalize({
          servers: Object.fromEntries(
            Array.from({ length: 32 }, (_, index) => [
              `Server ${index}`,
              {
                command: 'tool',
                env: Object.fromEntries(
                  Array.from({ length: 9 }, (_, binding) => [
                    `KEY_${binding}`,
                    importSecret,
                  ]),
                ),
              },
            ]),
          ),
        }),
      ).toThrow();
      const sensitiveBuffers = from.mock.results
        .map((result, index) =>
          from.mock.calls[index]?.[0] === importSecret
            ? (result.value as Buffer)
            : null,
        )
        .filter((value): value is Buffer => Buffer.isBuffer(value));
      expect(sensitiveBuffers).toHaveLength(256);
      expect(
        sensitiveBuffers.every((value) => value.every((byte) => byte === 0)),
      ).toBe(true);
    } finally {
      from.mockRestore();
    }
  });
  it.each(['mcpServers', 'servers', 'opencode', 'single', 'docker'])(
    'supports the %s input shape with equivalent remote semantics',
    (format) => {
      const server = {
        name: 'Service',
        url: 'https://example.test/mcp',
        type: 'remote',
      };
      const shapes = {
        mcpServers: { mcpServers: { Service: server } },
        servers: { servers: { Service: server } },
        opencode: { mcp: { servers: { Service: server } } },
        single: server,
        docker: {
          server: {
            ...server,
            url: undefined,
            remote: { url: server.url, transport_type: 'streamable-http' },
          },
        },
      };
      const draft = normalize(shapes[format as keyof typeof shapes]);
      expect(draft.format).toBe(format);
      expect(draft.entries[0]).toMatchObject({
        issues: [],
        definition: {
          executionMode: 'remote',
          transport: 'streamable_http',
          name: 'Service',
          trustApproval: null,
        },
      });
      clearImport(draft);
    },
  );
  it('sorts maps and bindings deterministically, independent of object property insertion order', () => {
    const a = normalize({
      mcpServers: {
        Z: {
          command: 'uvx',
          args: ['synthetic==1.2.3'],
          env: { B: importSecret, A: importSecret },
        },
        A: { url: 'https://example.test' },
      },
    });
    const b = normalize({
      mcpServers: {
        A: { url: 'https://example.test' },
        Z: {
          env: { A: importSecret, B: importSecret },
          args: ['synthetic==1.2.3'],
          command: 'uvx',
        },
      },
    });
    expect(a.entries).toEqual(b.entries);
    expect(a.references).toEqual(b.references);
    expect(a.entries.map((entry) => entry.name)).toEqual(['A', 'Z']);
    clearImport(a);
    clearImport(b);
  });
  it('preserves command/argument case, spaces, quotes, Unicode and metacharacters without expansion', () => {
    const args = [
      '--CaseSensitive',
      'Some Value',
      '"quoted"',
      'عربي',
      '$(command); & | > file',
      '%HOME%',
      '${VAR}',
    ];
    const result = entry({
      command: 'C:\\Program Files\\Synthetic\\Tool.exe',
      args,
    });
    expect(result.issues).toEqual([]);
    expect(result.definition).toMatchObject({
      executable: 'C:\\Program Files\\Synthetic\\Tool.exe',
      arguments: args,
    });
    expect(result.warnings).toContain('shell_syntax_inert');
  });
  it('projects only references while retaining bounded private header/environment buffers in memory', () => {
    const draft = normalize(mixedImport);
    expect(
      draft.entries.every((entry) => !entry.issues.length && entry.definition),
    ).toBe(true);
    expect(draft.secrets.size).toBe(3);
    expect(draft.references).toHaveLength(3);
    expect(
      JSON.stringify({ entries: draft.entries, references: draft.references }),
    ).not.toContain(importSecret);
    const buffers = [...draft.secrets.values()];
    expect(buffers.some((value) => value.toString() === importSecret)).toBe(
      true,
    );
    clearImport(draft);
    expect(draft.secrets.size).toBe(0);
    expect(buffers.every((value) => value.every((byte) => byte === 0))).toBe(
      true,
    );
  });
  it('treats every env value as private, even ordinary-looking literals, unless explicitly safe-listed', () => {
    const result = entry({
      command: 'tool.exe',
      env: { NODE_ENV: 'production' },
      environmentLiterals: { NO_COLOR: '1' },
    });
    expect(result.definition).toMatchObject({
      secretBindings: { NODE_ENV: expect.stringMatching(/^draft-/) },
      environmentLiterals: { NO_COLOR: '1' },
    });
    expect(JSON.stringify(result)).not.toContain('production');
  });
  it.each([
    { url: 'https://example.test', command: 'tool' },
    { url: 'https://example.test', image: 'image:1' },
    { command: ['tool', 'arg'], args: ['other'] },
    { command: 'tool', env: {}, environment: {} },
    { url: 'https://example.test', remote: { url: 'https://other.test' } },
    { command: 'tool', enabled: true, disabled: false },
  ])(
    'blocks ambiguous input without creating a partial definition: %j',
    (input) => {
      const result = entry(input);
      expect(result.definition).toBeNull();
      expect(
        result.issues.some((issue) => issue.code === 'ambiguous_shape'),
      ).toBe(true);
    },
  );
  it.each([
    { url: 'https://example.test', type: 'stdio' },
    { command: 'tool', transport: 'sse' },
    { image: 'image:1', type: 'remote' },
    { url: 'https://example.test', type: 'sse', transport: 'http' },
  ])('rejects conflicting transports: %j', (input) => {
    expect(
      entry(input).issues.some((issue) => issue.code === 'invalid_transport'),
    ).toBe(true);
  });
  it.each([
    'https://user:pass@example.test/mcp',
    'https://example.test/mcp?token=hidden',
    'https://example.test/mcp#hidden',
    'http://192.168.1.2:80',
    'file:///C:/private',
  ])('never returns a credential-bearing/unsupported URL: %s', (url) => {
    const result = entry({ url });
    expect(result.definition).toBeNull();
    expect(JSON.stringify(result)).not.toContain(url);
    expect(result.issues).toContainEqual({
      code: 'invalid_endpoint',
      field: 'url',
    });
  });
  it.each([
    'npx -y package',
    'tool && do-other',
    'powershell -Command anything',
    '',
    '\\\\host\\share\\tool.exe',
  ])(
    'does not split a pasted shell command or resolve a remote executable: %s',
    (command) => {
      expect(
        entry({ command }).issues.some(
          (issue) => issue.code === 'invalid_command',
        ),
      ).toBe(true);
    },
  );
  it.each([
    'Write-Output "hello"',
    'import os; os.system("anything")',
    'console.log("anything")',
    '{broken',
    '[{"command":"tool"}]',
    '{}',
    '{"command":"first","command":"second"}',
    '{"command":"tool","env":{"X":"first","X":"second"}}',
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{}}',
    '{"mcpServers":{},"servers":{}}',
    '{"mcpServers":{"A":{"url":"https://example.test"}},"command":"tool"}',
  ])(
    'rejects malformed/program/mixed/duplicate-key input without echoing it',
    (source) => {
      expect(() => normalizeImport(source)).toThrow(
        'Use bounded JSON configuration',
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );
  it('rejects oversized, deeply nested, and oversized multi-entry inputs', () => {
    expect(() => normalizeImport(' '.repeat(48 * 1024) + '{}')).toThrow();
    expect(() =>
      normalizeImport('{"a":'.repeat(30) + '{}' + '}'.repeat(30)),
    ).toThrow();
    expect(() =>
      normalize({
        servers: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `entry${index}`,
            { command: 'tool' },
          ]),
        ),
      }),
    ).toThrow();
    expect(() =>
      normalizeImport(
        JSON.stringify({ name: '😀'.repeat(13 * 1024), command: 'tool' }),
      ),
    ).toThrow();
  });
  it('reports unsupported fields without echoing their values and blocks partial wrapper imports', () => {
    const draft = normalize({
      mcpServers: { Good: { command: 'tool', cwd: importSecret }, Bad: null },
      ignoredRoot: { token: importSecret },
    });
    expect(draft.entries.every((entry) => entry.definition === null)).toBe(
      true,
    );
    expect(
      draft.entries.find((entry) => entry.name === 'Good')?.issues,
    ).toEqual(
      expect.arrayContaining([
        { code: 'unsupported_fields', field: 'cwd' },
        { code: 'unsupported_fields', field: 'root.ignoredRoot' },
      ]),
    );
    expect(JSON.stringify(draft.entries)).not.toContain(importSecret);
    clearImport(draft);
  });
  it.each([
    { command: 'tool', env: { API_KEY: '{env:PRIVATE}' } },
    { url: 'https://example.test', headers: { Authorization: '${PRIVATE}' } },
    { command: 'tool', env: { KEY: '%PRIVATE%' } },
  ])(
    'rejects unresolved references rather than reading files/environment: %j',
    (input) => {
      expect(
        entry(input).issues.some(
          (issue) => issue.code === 'unresolved_reference',
        ),
      ).toBe(true);
    },
  );
  it.each([
    { command: 'tool', env: null },
    { command: 'tool', env: { KEY: 123 } },
    { command: 'tool', env: { KEY: 'line\nbreak' } },
    {
      url: 'https://example.test',
      headers: { Authorization: 'one', authorization: 'two' },
    },
    { command: 'tool', environmentLiterals: { PATH: 'C:\\unsafe' } },
    { command: 'tool', environmentLiterals: { NODE_ENV: importSecret } },
  ])(
    'rejects malformed bindings or unsafe literal environments: %j',
    (input) => {
      const result = entry(input);
      expect(result.definition).toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
    },
  );
  it('does not echo repeated secrets in names, descriptions, command args, IDs, or unsupported-field labels', () => {
    const draft = normalize({
      servers: {
        [importSecret]: {
          command: 'tool',
          args: [importSecret],
          env: { TOKEN: importSecret },
          description: importSecret,
          id: importSecret.toLowerCase(),
        },
        Other: {
          command: 'tool',
          headers: { Authorization: `Bearer ${importSecret}` },
          [importSecret]: true,
        },
      },
    });
    expect(JSON.stringify(draft.entries)).not.toContain(importSecret);
    expect(draft.entries.every((entry) => !entry.definition)).toBe(true);
    clearImport(draft);
  });
  it.each([
    '--token=private',
    '--api-key',
    'Bearer private',
    'https://user:pass@example.test',
    'https://example.test?token=private',
  ])(
    'requires command credentials to be moved to supported bindings: %s',
    (arg) => {
      expect(
        entry({ command: 'tool', args: [arg] }).issues.some(
          (issue) => issue.code === 'credential_in_definition',
        ),
      ).toBe(true);
    },
  );
  it.each([
    { command: 'powershell.exe', args: ['-EncodedCommand', 'synthetic'] },
    { command: 'cmd.exe', args: ['/c', 'synthetic'] },
    { command: 'node', args: ['--eval', 'synthetic'] },
  ])(
    'rejects inline interpreter programs rather than disguising them as a config: %j',
    (input) => {
      expect(entry(input).issues).toContainEqual({
        code: 'invalid_command',
        field: 'inline_program',
      });
    },
  );
  it('shows explicit execution/download/pinning risks without trust approval', () => {
    const npx = entry({ command: 'npx', args: ['-y', 'synthetic@latest'] });
    expect(npx.warnings).toEqual(
      expect.arrayContaining([
        'native_execution_approval',
        'package_download',
        'unpinned_package',
        'host_file_access',
      ]),
    );
    expect(
      entry({ command: ['uvx', 'synthetic==1.2.3'] }).warnings,
    ).not.toContain('unpinned_package');
    expect(entry({ image: 'synthetic:latest' }).warnings).toEqual(
      expect.arrayContaining([
        'image_pull',
        'unpinned_image',
        'image_execution_approval',
      ]),
    );
    expect(
      entry({
        command: 'powershell.exe',
        args: ['-NoProfile', '-File', 'C:\\Synthetic\\launcher.ps1'],
      }).definition?.trustApproval,
    ).toBeNull();
  });
  it('emits strict definitions and does not import supplied trust approvals', () => {
    const result = entry({ command: ['npx', '-y', 'synthetic@1.2.3'] });
    expect(ImportDefinitionSchema.safeParse(result.definition).success).toBe(
      true,
    );
    expect(
      entry({ command: 'tool', trustApproval: { approved: true } }).issues,
    ).toContainEqual({ code: 'unsupported_fields', field: 'trustApproval' });
  });
});
