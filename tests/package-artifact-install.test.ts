import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArtifact } from '../packages/hub-core/src/packages/artifact.js';
import { resolvePackage } from '../packages/hub-core/src/packages/resolve.js';
import { installPackage } from '../packages/hub-core/src/packages/install.js';
import { createPreviewStore } from '../packages/hub-core/src/packages/previews.js';
import {
  createPackageLock,
  createPrivateDirectory,
  installDirectory,
  jobDirectory,
} from '../packages/hub-core/src/packages/store.js';
import { createSimpleTarball } from './helpers/fixture-registry.js';

vi.mock('../packages/hub-core/src/packages/artifact.js', async (original) => ({
  ...(await original<
    typeof import('../packages/hub-core/src/packages/artifact.js')
  >()),
  downloadArtifact: vi.fn(),
}));
afterEach(() => vi.mocked(downloadArtifact).mockReset());

describe('artifact root uses the actual isolated bundled npm', () => {
  it('resolves, freezes and installs exact bytes without any npm-published root or package scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wmh-artifact-install-'));
    const packagesDir = join(root, 'packages');
    const previews = createPreviewStore({ packagesDir });
    try {
      await createPrivateDirectory(packagesDir);
      const bytes = await createSimpleTarball(
        {
          'package.json': JSON.stringify({
            name: '@fixture/artifact',
            version: '1.0.0',
            bin: { fixture: 'bin/fixture.js' },
            scripts: { install: 'THIS_MUST_NEVER_EXECUTE' },
          }),
          'bin/fixture.js': '#!/usr/bin/env node\nprocess.exit(0);\n',
        },
        root,
      );
      vi.mocked(downloadArtifact).mockResolvedValue(bytes);
      const source = {
        kind: 'github-release' as const,
        repository: 'owner/repository',
        tag: 'v1.0.0',
        assetName: 'root.tgz',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const signal = new AbortController().signal;
      const preview = await resolvePackage({
        request: { name: '@fixture/artifact', version: '1.0.0', source },
        owner: 'fixture-owner',
        packagesDir,
        signal,
        previews,
      });
      expect(preview.source).toEqual(source);
      expect(preview.warnings).toContain('install_scripts');
      const record = await previews.take(preview.previewId, 'fixture-owner');
      const lock = JSON.parse(Buffer.from(record.lock).toString('utf8'));
      expect(lock.packages['node_modules/@fixture/artifact'].resolved).toBe(
        'file:root-artifact.tgz',
      );
      const saved = vi.fn(async () => ({
        status: 'committed' as const,
        connectorId: 'fixture',
        outcome: 'saved' as const,
      }));
      const result = await installPackage({
        record,
        entry: 'fixture',
        acknowledgedWarnings: preview.warnings,
        packagesDir,
        lock: createPackageLock(),
        signal,
        save: saved,
      });
      expect(saved).toHaveBeenCalledOnce();
      expect(result.provenance.source).toEqual(source);
      expect(result.provenance.integrity).toBe(preview.integrity);
      const folder = installDirectory(packagesDir, result.provenance.installId);
      expect(await readFile(join(folder, 'root-artifact.tgz'))).toEqual(bytes);
      expect(await readFile(join(folder, 'package-lock.json'))).toEqual(
        Buffer.from(record.lock),
      );
      expect(
        JSON.parse(
          await readFile(
            join(folder, 'node_modules/@fixture/artifact/package.json'),
            'utf8',
          ),
        ).version,
      ).toBe('1.0.0');
    } finally {
      await previews.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses archive drift after preview before installer calls npm or saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wmh-artifact-drift-'));
    const packagesDir = join(root, 'packages');
    const previews = createPreviewStore({ packagesDir });
    try {
      await createPrivateDirectory(packagesDir);
      const bytes = await createSimpleTarball(
        {
          'package.json': JSON.stringify({
            name: 'fixture',
            version: '1.0.0',
            bin: 'cli.js',
          }),
          'cli.js': 'no code execution',
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
      const signal = new AbortController().signal;
      const preview = await resolvePackage({
        request: { name: 'fixture', version: '1.0.0', source },
        owner: 'fixture-owner',
        packagesDir,
        signal,
        previews,
      });
      const record = await previews.take(preview.previewId, 'fixture-owner');
      await writeFile(
        join(
          jobDirectory(packagesDir, record.jobId),
          'project/root-artifact.tgz',
        ),
        'tampered',
      );
      const run = vi.fn(),
        save = vi.fn();
      await expect(
        installPackage({
          record,
          entry: 'fixture',
          acknowledgedWarnings: preview.warnings,
          packagesDir,
          lock: createPackageLock(),
          signal,
          runner: { run },
          save,
        }),
      ).rejects.toMatchObject({ code: 'integrity_mismatch' });
      expect(run).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    } finally {
      await previews.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
