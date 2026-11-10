import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConnectorSchema,
  PackageProvenanceSchema,
  type Connector,
} from '@waleed/contracts';
import { emptyState } from '../packages/hub-core/src/state.js';
import {
  createPackageService,
  type PackageHost,
} from '../packages/hub-core/src/packages/service.js';
import { downloadArtifact } from '../packages/hub-core/src/packages/artifact.js';
import { createPrivateDirectory } from '../packages/hub-core/src/packages/store.js';
import { exportConnectors } from '../packages/hub-core/src/imports/export.js';
import { createSimpleTarball } from './helpers/fixture-registry.js';
import { syntheticConnector } from './fixtures/native-connector.js';

vi.mock('../packages/hub-core/src/packages/artifact.js', async (original) => ({
  ...(await original<
    typeof import('../packages/hub-core/src/packages/artifact.js')
  >()),
  downloadArtifact: vi.fn(),
}));

describe('artifact replacement authorization', () => {
  it('requires exact source transition and refuses stale revisions without new npm/save calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wmh-artifact-service-'));
    const packagesDir = join(root, 'packages');
    await createPrivateDirectory(packagesDir);
    const bytes = await createSimpleTarball(
      {
        'package.json': JSON.stringify({
          name: 'fixture',
          version: '1.0.0',
          bin: 'cli.js',
        }),
        'cli.js': 'not executed',
      },
      root,
    );
    vi.mocked(downloadArtifact).mockResolvedValue(bytes);
    const source = {
      kind: 'github-release' as const,
      repository: 'owner/repo',
      tag: 'v1',
      assetName: 'root.tgz',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const provenance = PackageProvenanceSchema.parse({
      ecosystem: 'npm',
      name: 'fixture',
      version: '1.0.0',
      entry: 'fixture',
      entryPath: 'cli.js',
      installId: '12345678-1234-4234-8234-123456789abc',
      integrity,
      lockHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
    });
    const connector: Connector = ConnectorSchema.parse({
      ...syntheticConnector,
      package: provenance,
    });
    const state = { ...emptyState(), connectors: [connector] };
    const host: PackageHost = {
      inventory: async () => state,
      preview: vi.fn(),
      apply: vi.fn(),
      discard: vi.fn(),
      replacePackage: vi.fn(),
      drain: vi.fn(),
      job: vi.fn(),
      auth: { credentials: { write: vi.fn() } },
    };
    const run = vi.fn(async (request) => {
      const prefix = request.arguments
        .find((argument: string) => argument.startsWith('--prefix='))!
        .slice('--prefix='.length);
      await writeFile(
        join(prefix, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': {},
            'node_modules/fixture': {
              version: '1.0.0',
              resolved: 'file:root-artifact.tgz',
              integrity,
            },
          },
        }),
      );
      return {
        outcome: 'exited' as const,
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });
    const service = createPackageService(host, {
      packagesDir,
      nodeExecutable: process.execPath,
      runner: { run },
      selfTest: async () => undefined,
    });
    try {
      const started = service.resolve(
        { name: 'fixture', version: '1.0.0', source },
        'owner',
      );
      let resolved = service.job(started.id, 'owner');
      const deadline = Date.now() + 20_000;
      while (
        ['queued', 'running'].includes(resolved.state) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        resolved = service.job(started.id, 'owner');
      }
      expect(resolved.state).toBe('succeeded');
      const request = {
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        previewId: resolved.preview!.previewId,
        entry: 'fixture',
        acknowledgedWarnings: resolved.preview!.warnings,
      };
      const before = run.mock.calls.length;
      await expect(service.replace(request, 'owner')).rejects.toMatchObject({
        code: 'invalid',
      });
      await expect(
        service.replace(
          {
            ...request,
            sourceChange: {
              from: null,
              to: { ...source, sha256: 'b'.repeat(64) },
            },
          },
          'owner',
        ),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        service.replace(
          {
            ...request,
            expectedConnectorRevision: 999,
            sourceChange: { from: null, to: source },
          },
          'owner',
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        service.replace(
          { ...request, sourceChange: { from: null, to: source } },
          'other-owner',
        ),
      ).resolves.toMatchObject({ kind: 'replace' });
      // The other owner cannot consume this preview; close drains that refusal.
      await service.close();
      expect(run.mock.calls.length).toBe(before);
      expect(host.replacePackage).not.toHaveBeenCalled();
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses an export that would drop the source rather than labeling it an npm release', () => {
    const packageRecord = {
      ecosystem: 'npm' as const,
      name: 'fixture',
      version: '1.0.0',
      entry: 'fixture',
      entryPath: 'cli.js',
      installId: '12345678-1234-4234-8234-123456789abc',
      integrity: `sha512-${'a'.repeat(86)}==`,
      lockHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
    };
    expect(
      exportConnectors([
        ConnectorSchema.parse({
          ...syntheticConnector,
          package: packageRecord,
        }),
      ]).parts.length,
    ).toBeGreaterThan(0);
    const source = {
      kind: 'github-release' as const,
      repository: 'owner/repo',
      tag: 'v1',
      assetName: 'root.tgz',
      sha256: 'a'.repeat(64),
    };
    expect(() =>
      exportConnectors([
        ConnectorSchema.parse({
          ...syntheticConnector,
          package: { ...packageRecord, source },
        }),
      ]),
    ).toThrow('cannot preserve GitHub artifact provenance');
  });
});
