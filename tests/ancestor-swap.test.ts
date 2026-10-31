import { afterEach, expect, it, vi } from 'vitest';
import {
  link,
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

// Runs once, right before (or right after) the reader opens the armed path:
// the moment an attacker would swap a parent folder for a link, or move the
// file away.
const hook = vi.hoisted(() => ({
  path: '',
  beforeOpen: undefined as undefined | (() => Promise<void>),
  afterOpen: undefined as undefined | (() => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    if (args[0] === hook.path && hook.beforeOpen) {
      const run = hook.beforeOpen;
      hook.beforeOpen = undefined;
      await run();
    }
    const handle = await actual.open(...args);
    if (args[0] === hook.path && hook.afterOpen) {
      const run = hook.afterOpen;
      hook.afterOpen = undefined;
      await run();
    }
    return handle;
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
  refusedAsMissing,
  writeMarker,
} = await import('../packages/hub-core/src/packages/store.js');
const { emptyState } = await import('../packages/hub-core/src/state.js');
const { HubError } = await import('../packages/hub-core/src/errors.js');

let directory = '';
afterEach(async () => {
  hook.path = '';
  hook.beforeOpen = undefined;
  hook.afterOpen = undefined;
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

// Reconciliation keeps an install whose marker exists but is refused, and
// still reconciles every other entry in the same pass.
const reconcileWith = (packagesDir: string, active: string[]) =>
  reconcilePackages({
    packagesDir,
    readState: async () => emptyState(),
    activeJobs: () => new Set(active),
    lock: createPackageLock(),
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
  await expect(reconcileWith(packagesDir, [jobId])).resolves.toMatchObject({
    deleted: [],
  });
  await expect(readMarker(packagesDir + '-moved', installId)).resolves.toBe(
    jobId,
  );
  await expect(
    readFile(join(foreign, installId + '.installing'), 'utf8'),
  ).resolves.toBeTruthy();
});

it('keeps an active install when its marker vanishes after the open', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-vanish-reconcile-'));
  const packagesDir = packagesRoot(directory);
  await mkdir(packagesDir, { recursive: true });
  const installId = randomUUID();
  const jobId = randomUUID();
  const folder = join(packagesDir, installId);
  await mkdir(folder);
  await writeFile(join(folder, 'file.txt'), 'installing');
  await writeMarker(packagesDir, installId, jobId);
  const marker = markerPath(packagesDir, installId);
  hook.path = marker;
  hook.afterOpen = async () => {
    await rename(marker, join(directory, 'moved.installing'));
  };
  await expect(readOwnedFile(marker, 4096)).rejects.toMatchObject({
    code: 'conflict',
  });
  await rename(join(directory, 'moved.installing'), marker);
  hook.afterOpen = async () => {
    await rename(marker, join(directory, 'moved.installing'));
  };
  const result = await reconcileWith(packagesDir, [jobId]);
  expect(result.retained).toContain(installId);
  expect(result.deleted).toEqual([]);
  await expect(readFile(join(folder, 'file.txt'), 'utf8')).resolves.toBe(
    'installing',
  );
});

// An active install plus one stale, unreferenced folder in the same packages
// folder: the stale one must still be deleted in the pass.
const activeInstall = async (prefix: string) => {
  directory = await mkdtemp(join(tmpdir(), prefix));
  const packagesDir = packagesRoot(directory);
  await mkdir(packagesDir, { recursive: true });
  const installId = randomUUID();
  const jobId = randomUUID();
  const folder = join(packagesDir, installId);
  await mkdir(folder);
  await writeFile(join(folder, 'file.txt'), 'installing');
  const staleId = randomUUID();
  await mkdir(join(packagesDir, staleId));
  const reconcile = async () => {
    const result = await reconcileWith(packagesDir, [jobId]);
    expect(result.retained).toContain(installId);
    expect(result.deleted).toEqual([staleId]);
    await expect(readFile(join(folder, 'file.txt'), 'utf8')).resolves.toBe(
      'installing',
    );
  };
  return { packagesDir, installId, jobId, reconcile };
};

it('keeps an active install whose marker is a hard link', async () => {
  const { packagesDir, installId, jobId, reconcile } = await activeInstall(
    'wmh-refused-hardlink-',
  );
  await writeMarker(packagesDir, installId, jobId);
  await link(markerPath(packagesDir, installId), join(directory, 'extra'));
  await reconcile();
  await expect(readFile(join(directory, 'extra'), 'utf8')).resolves.toBe(jobId);
});

it('keeps an active install whose marker is a folder', async () => {
  const { packagesDir, installId, reconcile } = await activeInstall(
    'wmh-refused-folder-',
  );
  await mkdir(markerPath(packagesDir, installId));
  await reconcile();
});

it('keeps an active install whose marker holds no job id', async () => {
  const { packagesDir, installId, reconcile } = await activeInstall(
    'wmh-refused-malformed-',
  );
  await writeFile(markerPath(packagesDir, installId), 'not-a-job-id');
  await expect(readMarker(packagesDir, installId)).rejects.toMatchObject({
    code: 'conflict',
  });
  await reconcile();
  await expect(
    readFile(markerPath(packagesDir, installId), 'utf8'),
  ).resolves.toBe('not-a-job-id');
});

const fileLink = async (
  target: string,
  path: string,
  context: { skip: () => void },
) => {
  try {
    await symlink(target, path, 'file');
  } catch (error) {
    // Windows needs Developer Mode or elevation for a file link.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
    throw error;
  }
};

it('keeps an active install whose marker is a link', async (context) => {
  const { packagesDir, installId, jobId, reconcile } =
    await activeInstall('wmh-refused-link-');
  const target = join(directory, 'target.installing');
  await writeFile(target, jobId);
  await fileLink(target, markerPath(packagesDir, installId), context);
  await reconcile();
});

it('keeps an active install whose marker is a link to a missing file', async (context) => {
  const { packagesDir, installId, reconcile } = await activeInstall(
    'wmh-refused-dangling-',
  );
  await fileLink(
    join(directory, 'missing.installing'),
    markerPath(packagesDir, installId),
    context,
  );
  await reconcile();
});

it('refuses an owned file under a link to a missing folder', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-dangling-owned-'));
  const parent = join(directory, 'install');
  await symlink(join(directory, 'missing'), parent, 'junction');
  await expect(
    readOwnedFile(join(parent, 'marker.json'), 1024),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    readOwnedFile(join(directory, 'none.json'), 1024),
  ).resolves.toBeNull();
});

it('refuses an agent file under a link to a missing folder, or one that vanished after the open', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-dangling-agent-'));
  const parent = join(directory, 'agent');
  await symlink(join(directory, 'missing'), parent, 'junction');
  const dangling = join(parent, 'config.json');
  const real = join(directory, 'real', 'config.json');
  await mkdir(join(directory, 'real'));
  await writeFile(real, '{}');
  const files = agentFiles([dangling, real], join(directory, 'backups'));
  await expect(files.read(dangling)).rejects.toMatchObject({
    code: 'conflict',
  });
  hook.path = real;
  hook.afterOpen = async () => {
    await rename(real, real + '.moved');
  };
  await expect(files.read(real)).rejects.toMatchObject({ code: 'conflict' });
  await expect(files.read(real)).resolves.toBeNull();
});

it('refuses a managed file whose root is a link to a missing folder', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-dangling-managed-'));
  const roots = {
    runtime: join(directory, 'runtime'),
    catalog: join(directory, 'catalog'),
  };
  await symlink(join(directory, 'missing'), roots.catalog, 'junction');
  const files = managedFiles(roots);
  await expect(files.read('catalog', 'wmh-abcd.json')).rejects.toMatchObject({
    code: 'conflict',
  });
});

it('refuses an owned file over its size cap with an error', async () => {
  directory = await mkdtemp(join(tmpdir(), 'wmh-refused-size-'));
  const path = join(directory, 'big.json');
  await writeFile(path, 'x'.repeat(2048));
  await expect(readOwnedFile(path, 1024)).rejects.toMatchObject({
    code: 'conflict',
  });
  await expect(
    readOwnedFile(join(directory, 'none.json'), 1024),
  ).resolves.toBeNull();
});

it('maps only a refused owned file to the missing-file outcome', () => {
  expect(refusedAsMissing(new HubError('conflict', 'refused'))).toBeNull();
  const other = Object.assign(new Error('denied'), { code: 'EACCES' });
  expect(() => refusedAsMissing(other)).toThrow(other);
  expect(() => refusedAsMissing(new HubError('busy', 'busy'))).toThrow();
});
