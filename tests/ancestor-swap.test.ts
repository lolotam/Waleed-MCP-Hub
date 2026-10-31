import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs once, right before the reader opens the armed path: the moment an
// attacker would swap a parent folder for a link.
const hook = vi.hoisted(() => ({
  path: '',
  beforeOpen: undefined as undefined | (() => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    if (args[0] === hook.path && hook.beforeOpen) {
      const run = hook.beforeOpen;
      hook.beforeOpen = undefined;
      await run();
    }
    return actual.open(...args);
  }) as typeof actual.open;
  return { ...actual, open, default: { ...actual, open } };
});

const { agentFiles } =
  await import('../packages/hub-core/src/integrations/files.js');
const { managedFiles } =
  await import('../packages/hub-core/src/adapters/managed-files.js');
const {
  createPackageLock,
  markerPath,
  packagesRoot,
  readMarker,
  readOwnedFile,
  reconcilePackages,
  writeMarker,
} = await import('../packages/hub-core/src/packages/store.js');
const { emptyState } = await import('../packages/hub-core/src/state.js');

let directory = '';
afterEach(async () => {
  hook.path = '';
  hook.beforeOpen = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

// Replaces `parent` with a link (a junction on Windows) to `foreign`.
const swapParent = (parent: string, foreign: string) => async () => {
  await rename(parent, parent + '-moved');
  await symlink(foreign, parent, 'junction');
};

it('refuses an agent file whose parent folder became a link before the open', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-swap-agent-'));
  const parent = join(directory, 'agent');
  const foreign = join(directory, 'foreign');
  await mkdir(parent);
  await mkdir(foreign);
  const path = join(parent, 'config.json');
  await writeFile(path, '{"own":1}');
  await writeFile(join(foreign, 'config.json'), '{"foreign":1}');
  const files = agentFiles([path], join(directory, 'backups'));
  hook.path = path;
  hook.beforeOpen = swapParent(parent, foreign);
  await expect(files.read(path)).rejects.toMatchObject({ code: 'conflict' });
});

it('refuses a managed file whose root became a link before the open', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-swap-managed-'));
  const roots = {
    runtime: join(directory, 'runtime'),
    catalog: join(directory, 'catalog'),
  };
  const files = managedFiles(roots);
  await files.write('catalog', 'wmh-abcd.json', null, '{}');
  const foreign = join(directory, 'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign, 'wmh-abcd.json'), '{"foreign":1}');
  hook.path = files.path('catalog', 'wmh-abcd.json');
  hook.beforeOpen = swapParent(roots.catalog, foreign);
  await expect(files.read('catalog', 'wmh-abcd.json')).rejects.toMatchObject({
    code: 'conflict',
  });
});

it('refuses an owned package file whose parent folder became a link before the open', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-swap-owned-'));
  const parent = join(directory, 'install');
  const foreign = join(directory, 'foreign');
  await mkdir(parent);
  await mkdir(foreign);
  const path = join(parent, 'marker.json');
  await writeFile(path, 'own');
  await writeFile(join(foreign, 'marker.json'), 'foreign');
  hook.path = path;
  hook.beforeOpen = swapParent(parent, foreign);
  await expect(readOwnedFile(path, 1024)).rejects.toMatchObject({
    code: 'conflict',
  });
});

it('keeps an install marker when its folder became a link during reconciliation', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-swap-reconcile-'));
  const packagesDir = packagesRoot(directory);
  await mkdir(packagesDir, { recursive: true });
  const installId = randomUUID();
  const jobId = randomUUID();
  await writeMarker(packagesDir, installId, jobId);
  const foreign = join(directory, 'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign, installId + '.installing'), randomUUID());
  hook.path = markerPath(packagesDir, installId);
  hook.beforeOpen = swapParent(packagesDir, foreign);
  await expect(
    reconcilePackages({
      packagesDir,
      readState: async () => emptyState(),
      activeJobs: () => new Set([jobId]),
      lock: createPackageLock(),
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(readMarker(packagesDir + '-moved', installId)).resolves.toBe(
    jobId,
  );
  await expect(
    readFile(join(foreign, installId + '.installing'), 'utf8'),
  ).resolves.toBeTruthy();
});
