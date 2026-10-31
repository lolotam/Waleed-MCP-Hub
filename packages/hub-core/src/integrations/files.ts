import { lstat, mkdir, open, rename, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertNoLinks, checkedReadFlags } from '../adapters/managed-files.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import { HubError } from '../errors.js';

const conflict = () =>
  new HubError(
    'conflict',
    'Agent file changed, is unsafe or cannot be protected. Refresh the scan; inspect recovery before retrying.',
  );
const maxAgentFile = 1024n * 1024n;
export interface AgentFiles {
  read(path: string): Promise<string | null>;
  replace(path: string, before: string | null, after: string): Promise<void>;
  backup(agent: string, text: string): Promise<string>;
}
export async function restrictPrivatePath(path: string) {
  if (process.platform !== 'win32') return;
  const executable = win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const runner = await createWindowsProcessRunner({
    allowedExecutables: [executable],
    workingDirectory: dirname(path),
  });
  const result = await runner.run({
    executable,
    arguments: [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(new URL('./private-path.ps1', import.meta.url)),
    ],
    environment: {},
    stdin: JSON.stringify({ path }),
    signal: AbortSignal.timeout(32000),
    timeoutMs: 30000,
    outputLimitBytes: 1024,
  });
  if (
    result.outcome !== 'exited' ||
    result.exitCode !== 0 ||
    result.stdout !== 'ok'
  )
    throw conflict();
}
export function agentFiles(
  allowed: readonly string[],
  backupDirectory: string,
  protect = restrictPrivatePath,
): AgentFiles {
  const paths = new Set(allowed.map((path) => resolve(path).toLowerCase()));
  const permit = (path: string) => {
    if (
      !isAbsolute(path) ||
      !paths.has(resolve(path).toLowerCase()) ||
      path.slice(2).includes(':')
    )
      throw conflict();
  };
  async function read(path: string) {
    permit(path);
    await assertNoLinks(path, true);
    try {
      // The decision is made on the open handle, then the path must still
      // name that very file. File ids are compared as exact integers: a
      // Windows file id does not fit in a JavaScript number.
      const file = await open(path, checkedReadFlags);
      let bytes: Buffer | undefined;
      try {
        const opened = await file.stat({ bigint: true });
        if (
          !opened.isFile() ||
          opened.nlink !== 1n ||
          opened.size > maxAgentFile
        )
          throw conflict();
        const named = await lstat(path, { bigint: true });
        if (
          !named.isFile() ||
          named.ino !== opened.ino ||
          named.dev !== opened.dev
        )
          throw conflict();
        bytes = await file.readFile();
        if (bytes.length > 1024 * 1024 || bytes.includes(0)) throw conflict();
        return bytes.toString('utf8');
      } finally {
        bytes?.fill(0);
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    read,
    async backup(agent, text) {
      if (!/^[a-z-]+$/.test(agent)) throw conflict();
      await assertNoLinks(backupDirectory, true);
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      await assertNoLinks(backupDirectory);
      await protect(backupDirectory);
      const name = `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`;
      const file = await open(join(backupDirectory, name), 'wx', 0o600);
      const bytes = Buffer.from(text);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        bytes.fill(0);
        await file.close();
      }
      return name;
    },
    async replace(path, before, after) {
      permit(path);
      if (
        Buffer.byteLength(after) > 1024 * 1024 ||
        (await read(path)) !== before
      )
        throw conflict();
      const parent = dirname(path);
      await assertNoLinks(parent, true);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await assertNoLinks(parent);
      const temporary = join(parent, `.wmh-${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      const bytes = Buffer.from(after);
      try {
        await protect(temporary);
        await file.writeFile(bytes);
        await file.sync();
      } catch (error) {
        await file.close();
        await unlink(temporary).catch(() => undefined);
        throw error;
      } finally {
        bytes.fill(0);
      }
      await file.close();
      try {
        if ((await read(path)) !== before) throw conflict();
        if (before === null) {
          await link(temporary, path);
          await unlink(temporary);
        } else await rename(temporary, path);
        if ((await read(path)) !== after) throw conflict();
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
  };
}
export function outsideProtectedPilot(path: string, pilot: string) {
  const value = relative(resolve(pilot), resolve(path));
  if (!value || (!value.startsWith('..') && !isAbsolute(value)))
    throw conflict();
}
