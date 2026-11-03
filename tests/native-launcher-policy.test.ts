import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { emptySafetyState } from '../packages/hub-core/src/safety.js';
import {
  definitionHash,
  hashBytes,
} from '../packages/hub-core/src/runtime/registry.js';
import { profileState } from './helpers/runtime.js';

const runner = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Unexpected runner acquisition');
  }),
);
vi.mock('../packages/hub-core/src/adapters/native/process-runner.js', () => ({
  createWindowsProcessRunner: runner,
}));
import { runNativeLauncher } from '../packages/hub-core/src/runtime/launcher.js';

it.each(['current', 'saved'] as const)(
  'refuses a default-block %s native snapshot before acquiring the process runner',
  async (where) => {
    const directory = await mkdtemp(join(tmpdir(), 'hub-launcher-policy-'));
    const previous = process.exitCode;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    runner.mockClear();
    try {
      const state = profileState(['native']);
      const current = state.connectors[0]!;
      if (current.executionMode !== 'native')
        throw new Error('Synthetic native fixture required');
      current.executable = process.execPath;
      current.trustApproval!.definitionHash = definitionHash(current);
      const saved = structuredClone(current);
      if (where === 'current') current.defaultToolPolicy = 'block';
      else saved.defaultToolPolicy = 'block';
      const registryPath = join(directory, 'state.json');
      await writeFile(registryPath, JSON.stringify(state));
      await writeFile(
        join(directory, 'safety.json'),
        JSON.stringify(emptySafetyState()),
      );
      const raw = JSON.stringify({
        version: 1,
        profileId: 'profile',
        registryPath,
        connector: saved,
      });
      const manifest = join(directory, 'manifest.json');
      await writeFile(manifest, raw);
      await runNativeLauncher(pathToFileURL(manifest), hashBytes(raw));
      expect(process.exitCode).toBe(1);
      expect(runner).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('stale, disabled, unsafe, or unavailable'),
      );
    } finally {
      process.exitCode = previous;
      stderr.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
