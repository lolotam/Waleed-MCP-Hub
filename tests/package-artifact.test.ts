import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitHubArtifactSourceSchema,
  PackageProvenanceSchema,
  PackageResolveRequestSchema,
} from '@waleed/contracts';
import {
  inspectArtifact,
  artifactUrl,
  isArtifactUrl,
} from '../packages/hub-core/src/packages/artifact.js';
import { validateLock } from '../packages/hub-core/src/packages/resolve.js';
import { createSimpleTarball } from './helpers/fixture-registry.js';

const source = {
  kind: 'github-release' as const,
  repository: 'lolotam/ssh-mcp',
  tag: 'v2.1.0-waleed.1',
  assetName: 'ssh-mcp.tgz',
  sha256: 'a'.repeat(64),
};

describe('GitHub package artifacts', () => {
  it('requires an exact package version and strict source identity', () => {
    expect(
      PackageResolveRequestSchema.safeParse({ name: 'ssh-mcp', source })
        .success,
    ).toBe(false);
    expect(
      PackageResolveRequestSchema.safeParse({
        name: 'ssh-mcp',
        version: '^2.1.0',
        source,
      }).success,
    ).toBe(false);
    expect(
      PackageResolveRequestSchema.parse({
        name: 'ssh-mcp',
        version: '2.1.0',
        source,
      }).source,
    ).toEqual(source);
    for (const change of [
      { repository: '../x' },
      { tag: '..' },
      { tag: 'a/b' },
      { assetName: '../x.tgz' },
      { sha256: 'A'.repeat(64) },
      { token: 'no' },
    ]) {
      expect(
        GitHubArtifactSourceSchema.safeParse({ ...source, ...change }).success,
      ).toBe(false);
    }
  });

  it('constructs release URLs and refuses all foreign/ambiguous redirect destinations', () => {
    expect(artifactUrl(source)).toBe(
      'https://github.com/lolotam/ssh-mcp/releases/download/v2.1.0-waleed.1/ssh-mcp.tgz',
    );
    expect(
      isArtifactUrl(
        new URL('https://release-assets.githubusercontent.com/x?signature=abc'),
      ),
    ).toBe(true);
    for (const value of [
      'http://github.com/a',
      'https://github.com.evil.test/a',
      'https://user@github.com/a',
      'https://127.0.0.1/a',
      'https://raw.githubusercontent.com/a',
      'https://github.com:444/a',
      'https://github.com/a#x',
    ]) {
      expect(isArtifactUrl(new URL(value))).toBe(false);
    }
  });

  it('checks hashes before parsing and reads only a bounded package manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wmh-artifact-test-'));
    try {
      const bytes = await createSimpleTarball(
        {
          'package.json': JSON.stringify({
            name: 'ssh-mcp',
            version: '2.1.0',
            bin: { 'ssh-mcp': 'build/index.js' },
          }),
          'build/index.js': 'no execution',
        },
        root,
      );
      const expected = {
        ...source,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const result = await inspectArtifact(
        bytes,
        expected,
        new AbortController().signal,
      );
      expect(result.document.name).toBe('ssh-mcp');
      expect(result.integrity).toBe(
        `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      );
      await expect(
        inspectArtifact(bytes, source, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'integrity_mismatch' });
      await expect(
        inspectArtifact(bytes, expected, AbortSignal.abort()),
      ).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('admits a local archive only for the pinned root and refuses nested file resolutions', () => {
    const integrity = `sha512-${'a'.repeat(86)}==`;
    const root = { name: 'ssh-mcp', version: '2.1.0', integrity, source };
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/ssh-mcp': {
          version: '2.1.0',
          resolved: 'file:root-artifact.tgz',
          integrity,
        },
      },
    };
    expect(
      validateLock(lock, root, 'https://registry.npmjs.org').installed,
    ).toHaveLength(1);
    expect(() =>
      validateLock(
        lock,
        { name: root.name, version: root.version, integrity },
        'https://registry.npmjs.org',
      ),
    ).toThrow();
    expect(() =>
      validateLock(
        {
          ...lock,
          packages: {
            ...lock.packages,
            'node_modules/other': {
              version: '1.0.0',
              resolved: 'file:root-artifact.tgz',
              integrity,
            },
          },
        },
        root,
        'https://registry.npmjs.org',
      ),
    ).toThrow();
  });
});

// Tiny synthetic tar builder permits hostile headers without making unsafe
// filesystem entries. The bytes are inspected only, never extracted/executed.
function rawArchive(
  entries: Array<{ path: string; type?: string; body?: string }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000001\0', 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe('archive structure and compatibility', () => {
  const manifest = {
    path: 'package/package.json',
    body: '{"name":"fixture","version":"1.0.0","bin":"cli.js"}',
  };
  it.each(
    [
      [{ path: 'package/../escape' }],
      [{ path: '/absolute' }],
      [{ path: 'package/CON' }],
      [{ path: 'package/cli.js', type: '2' }],
      [{ path: 'package/cli.js', type: '1' }],
      [{ path: 'package/device', type: '3' }],
      [{ path: 'package/pipe', type: '6' }],
      [manifest],
      [{ path: 'package/A.js' }, { path: 'package/a.js' }],
      [{ path: 'package/folder' }, { path: 'package/folder/child' }],
      [{ path: 'package/Folder/a' }, { path: 'package/folder/b' }],
    ].map((extra) => ({ extra })),
  )(
    'refuses dangerous tar headers without extracting (%j)',
    async ({ extra }) => {
      const bytes = rawArchive([manifest, ...extra]);
      await expect(
        inspectArtifact(
          bytes,
          {
            ...source,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'install_failed' });
    },
  );
  it('caps the manifest body', async () => {
    const bytes = rawArchive([
      { ...manifest, body: ' '.repeat(1024 * 1024 + 1) },
    ]);
    await expect(
      inspectArtifact(
        bytes,
        { ...source, sha256: createHash('sha256').update(bytes).digest('hex') },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'install_limit' });
  });
  it('preserves source provenance while prior strict schema refuses it', () => {
    const value = {
      ecosystem: 'npm',
      name: 'fixture',
      version: '1.0.0',
      entry: 'fixture',
      entryPath: 'cli.js',
      installId: '12345678-1234-4234-8234-123456789abc',
      integrity: `sha512-${'a'.repeat(86)}==`,
      lockHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
    };
    const oldShape = PackageProvenanceSchema.omit({ source: true });
    expect(oldShape.safeParse(value).success).toBe(true);
    expect(oldShape.safeParse({ ...value, source }).success).toBe(false);
    expect(PackageProvenanceSchema.parse({ ...value, source }).source).toEqual(
      source,
    );
  });
});
