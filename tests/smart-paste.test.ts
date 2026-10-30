import { expect, it } from 'vitest';
import {
  parseSmartPaste,
  clearSmartPaste,
  smartPasteImportSource,
} from '@waleed/contracts';
import {
  normalizeImport,
  clearImport,
} from '../packages/hub-core/src/imports/normalize.js';
it.each([
  [
    'https://example.test/mcp',
    'url',
    { type: 'streamable_http', url: 'https://example.test/mcp' },
  ],
  [
    'http://127.0.0.1:3000/mcp',
    'url',
    { type: 'streamable_http', url: 'http://127.0.0.1:3000/mcp' },
  ],
  [
    'http://localhost:8080/sse',
    'url',
    { type: 'streamable_http', url: 'http://localhost:8080/sse' },
  ],
  [
    'npx -y @modelcontextprotocol/server-postgres@0.1.0 --read-only',
    'npx',
    {
      type: 'npx',
      packageName: '@modelcontextprotocol/server-postgres',
      entryPoint: 'mcp-server-postgres',
      packageVersion: '0.1.0',
      args: ['--read-only'],
    },
  ],
  [
    'uvx mcp-server-git==1.2.0 "C:\\Synthetic Space"',
    'uvx',
    {
      type: 'uvx',
      packageName: 'mcp-server-git',
      packageVersion: '1.2.0',
      entryPoint: 'mcp-server-git',
      args: ['C:\\Synthetic Space'],
    },
  ],
  [
    'ghcr.io/synthetic/mcp:1.2.3',
    'docker',
    { type: 'docker', image: 'ghcr.io/synthetic/mcp:1.2.3' },
  ],
  [
    'docker run --rm -i synthetic/mcp:1.2.3 --mode read',
    'docker',
    { type: 'docker', image: 'synthetic/mcp:1.2.3', args: ['--mode', 'read'] },
  ],
] as const)('detects %s as inert %s data', (input, kind, prefill) => {
  const result = parseSmartPaste(input);
  try {
    expect(result.kind).toBe(kind);
    if (result.kind === 'json') throw new Error();
    expect(result.prefill).toMatchObject(prefill);
  } finally {
    clearSmartPaste(result);
  }
});
it.each([
  { mcpServers: { One: { url: 'https://example.test/mcp' } } },
  { servers: { One: { command: 'npx', args: ['pkg@1.2.3'] } } },
  { url: 'https://example.test/mcp' },
])(
  'preserves supported JSON text for authoritative normalization (%j)',
  (value) => {
    const source = JSON.stringify(value),
      result = parseSmartPaste(source);
    expect(result.kind).toBe('json');
    expect(smartPasteImportSource(result)).toBe(source);
    clearSmartPaste(result);
    expect(result).toHaveProperty('source', '');
  },
);
it('preserves duplicate JSON keys for the backend to reject, rather than silently overwriting them', () => {
  const source =
      '{"mcpServers":{"one":{"url":"https://example.test/a"},"one":{"url":"https://example.test/b"}}}',
    value = parseSmartPaste(source);
  try {
    expect(() => normalizeImport(smartPasteImportSource(value))).toThrow();
  } finally {
    clearSmartPaste(value);
  }
});
it('extracts Docker env values privately and maps published ports to loopback without executing flags', () => {
  const secret = 'SYNTHETIC-SMART-PRIVATE-0123456789';
  const result = parseSmartPaste(
    `docker run --rm -i -e TOKEN="${secret}" --publish=3000:8080 synthetic/mcp:1.2.3 --Case "A B"`,
  );
  if (result.kind === 'json') throw new Error();
  expect(result.prefill).toMatchObject({
    env: { TOKEN: secret },
    ports: [{ host: 3000, container: 8080 }],
    args: ['--Case', 'A B'],
  });
  expect(JSON.stringify([result.summary, result.warnings])).not.toContain(
    secret,
  );
  const draft = normalizeImport(smartPasteImportSource(result));
  try {
    expect(draft.entries[0]!.definition).toMatchObject({
      executionMode: 'docker',
      portBindings: [{ host: 3000, container: 8080 }],
    });
    expect(JSON.stringify(draft.entries)).not.toContain(secret);
  } finally {
    clearImport(draft);
  }
  clearSmartPaste(result);
  expect(result.prefill.env.TOKEN).toBe('');
  expect(result.prefill.args).toEqual([]);
});
it('does not invent versions or grant local HTTP consent when making import sources', () => {
  for (const input of [
    'npx synthetic-mcp',
    'uvx synthetic-mcp',
    'npx synthetic-mcp@latest',
  ]) {
    const value = parseSmartPaste(input);
    try {
      if (value.kind === 'json') throw new Error();
      expect(value.warnings.join(' ')).toContain('exact package version');
      const draft = normalizeImport(smartPasteImportSource(value));
      try {
        expect(draft.entries[0]!.warnings).toContain('unpinned_package');
      } finally {
        clearImport(draft);
      }
    } finally {
      clearSmartPaste(value);
    }
  }
  const value = parseSmartPaste('http://localhost:8080/mcp');
  try {
    const draft = normalizeImport(smartPasteImportSource(value));
    try {
      expect(draft.entries[0]!.issues).toContainEqual({
        code: 'local_http_opt_in_required',
        field: 'localHttpOptIn',
      });
    } finally {
      clearImport(draft);
    }
  } finally {
    clearSmartPaste(value);
  }
});
it.each([
  'http://192.168.0.1:3000/mcp',
  'https://user:private@example.test/mcp',
  'https://example.test/mcp?token=private',
  'npx pkg@1.2.3 && echo private',
  'uvx pkg==1.2.3 $(echo private)',
  'npx --package pkg@1.2.3 bin',
  'npx pkg@1.2.3 --call private',
  'npx pkg@1.2.3 --token=private',
  'docker run --privileged image',
  'docker run -v C:\\private:/data image',
  'docker run --env-file .env image',
  'docker run -e TOKEN image',
  'docker run -p 0.0.0.0:8080:80 image',
  'docker run --network host image',
  'docker run -it image',
  'docker run image --password private',
  '{bad json private}',
  '[1,2,3]',
])(
  'rejects unsafe/unsupported Smart Paste input without reflecting it: %s',
  (input) => {
    try {
      parseSmartPaste(input);
      throw new Error('unexpected parse success');
    } catch (error) {
      expect(String(error)).not.toContain('unexpected parse success');
      expect(String(error)).not.toContain('private');
    }
  },
);
it('keeps quoted shell-looking text literal, rejects oversized input, and never evaluates a string', () => {
  const value = parseSmartPaste('npx pkg@1.2.3 "$(not-executed); & inert"');
  try {
    if (value.kind === 'json') throw new Error();
    expect(value.prefill.args).toEqual(['$(not-executed); & inert']);
  } finally {
    clearSmartPaste(value);
  }
  expect(() => parseSmartPaste('x'.repeat(48 * 1024 + 1))).toThrow('48 KiB');
});
