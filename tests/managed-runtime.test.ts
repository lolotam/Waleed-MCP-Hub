import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector } from '@waleed/contracts';
import { syntheticConnector } from './fixtures/native-connector.js';
import { definitionHash } from '../packages/hub-core/src/runtime/registry.js';
import {
  createCapabilityRuntime,
  nativeExecutable,
} from '../packages/hub-core/src/adapters/mcp/runtime.js';

const ports = vi.hoisted(() => ({ verify: vi.fn(), runner: vi.fn() }));
vi.mock('../packages/hub-core/src/packages/verify.js', () => ({
  verifyPackage: ports.verify,
}));
vi.mock('../packages/hub-core/src/adapters/native/process-runner.js', () => ({
  createWindowsProcessRunner: ports.runner,
}));
vi.mock(
  '../packages/hub-core/src/runtime/capabilities.js',
  async (original) => ({
    ...(await original<
      typeof import('../packages/hub-core/src/runtime/capabilities.js')
    >()),
    enumerateCapabilities: vi.fn(async () => ({
      tools: [],
      resourceCount: 0,
      promptCount: 0,
    })),
  }),
);

let directory = '';
function managed(): Extract<Connector, { executionMode: 'native' }> {
  return {
    ...syntheticConnector,
    executionMode: 'native',
    transport: 'stdio',
    // Issue #21: the old installation has already been removed.
    executable: join(directory, 'removed-install', 'runtime', 'node.exe'),
    arguments: ['--no-global-search-paths', 'C:\\Packages\\server\\index.js'],
    package: {
      ecosystem: 'npm',
      name: 'fixture',
      version: '1.0.0',
      entry: 'fixture',
      entryPath: 'index.js',
      installId: randomUUID(),
      integrity: `sha512-${'A'.repeat(86)}==`,
      lockHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
    },
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-managed-runtime-'));
  vi.clearAllMocks();
  ports.verify.mockResolvedValue(undefined);
  ports.runner.mockResolvedValue({});
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'win32')(
  'checks an approved package with the current runtime after its old install disappears (#21)',
  async () => {
    const connector = managed();
    const saved = structuredClone(connector);
    const hash = definitionHash(connector);
    await createCapabilityRuntime({ workingDirectory: directory }).discover(
      connector,
      AbortSignal.timeout(5000),
    );
    expect(ports.verify).toHaveBeenCalledWith(
      connector,
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(ports.runner).toHaveBeenCalledWith(
      expect.objectContaining({ allowedExecutables: [process.execPath] }),
    );
    expect(connector).toEqual(saved);
    expect(definitionHash(connector)).toBe(hash);
  },
);
it('refuses a modified package before opening a process runner (#21)', async () => {
  ports.verify.mockRejectedValue(new Error('modified package'));
  await expect(
    createCapabilityRuntime({ workingDirectory: directory }).discover(
      managed(),
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow('modified package');
  expect(ports.runner).not.toHaveBeenCalled();
});
it('preserves arbitrary native executables instead of substituting Node', async () => {
  const connector = managed();
  delete connector.package;
  await expect(nativeExecutable(connector)).resolves.toBe(connector.executable);
});
