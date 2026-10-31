import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoLinks, readOwnedFile } from '../managed-files.js';
import { createWindowsProcessRunner } from '../native/process-runner.js';
import { HubError } from '../../errors.js';
import {
  assertSecretId,
  assertSecretValue,
  type SecretBackend,
} from '../../auth/secrets.js';

const unavailable = () =>
  new HubError(
    'unavailable',
    'The current-user protected credential store is unavailable.',
  );
export async function windowsSecretStore(
  directory: string,
  readOnly = false,
): Promise<SecretBackend> {
  if (process.platform !== 'win32') throw unavailable();
  await assertNoLinks(directory, !readOnly);
  if (!readOnly) await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoLinks(directory);
  const executable = win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const runner = await createWindowsProcessRunner({
    allowedExecutables: [executable],
    workingDirectory: directory,
    concurrency: 2,
  });
  const script = fileURLToPath(new URL('./dpapi.ps1', import.meta.url));
  async function invoke(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await runner.run({
      executable,
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script],
      environment: {},
      stdin: JSON.stringify(input),
      signal,
      timeoutMs: 10_000,
      outputLimitBytes: 64 * 1024,
    });
    if (result.outcome !== 'exited' || result.exitCode !== 0)
      throw unavailable();
    return result.stdout;
  }
  if (!readOnly)
    await invoke(
      { action: 'acl', path: directory },
      AbortSignal.timeout(12_000),
    );
  const scopePath = join(directory, 'scope.json');
  await assertNoLinks(scopePath, true);
  try {
    if (!readOnly) {
      const file = await open(scopePath, 'wx', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ version: 1, scope: randomUUID() }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
  }
  // Checked and read through one handle, so it cannot be swapped between
  // the check and the read.
  const scopeBytes = await readOwnedFile(scopePath, 256).catch(() => {
    throw unavailable();
  });
  if (scopeBytes === null) throw unavailable();
  const scope: unknown = JSON.parse(scopeBytes.toString('utf8'));
  if (
    !scope ||
    typeof scope !== 'object' ||
    !('scope' in scope) ||
    typeof scope.scope !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(scope.scope)
  )
    throw unavailable();
  const context = scope.scope;
  const pathFor = (id: string) => {
    assertSecretId(id);
    return join(directory, `${id}.dpapi`);
  };
  const entropyFor = (id: string) =>
    createHash('sha256')
      .update(`WaleedMcpHub/credentials/v1/${context}/${id}`)
      .digest();
  async function encrypted(id: string) {
    const path = pathFor(id);
    // Missing is null; a link, a hard link or an oversized file is refused.
    try {
      return await readOwnedFile(path, 32 * 1024);
    } catch {
      throw unavailable();
    }
  }
  return {
    async has(id) {
      const value = await encrypted(id);
      const present = value !== null;
      value?.fill(0);
      return present;
    },
    async put(id, value, signal) {
      if (readOnly) throw unavailable();
      assertSecretValue(value);
      const path = pathFor(id);
      if (await encrypted(id))
        throw new HubError(
          'conflict',
          'Secret identifiers are immutable; rotate to a new reference.',
        );
      const entropy = entropyFor(id);
      let cipher: Buffer | undefined;
      try {
        const raw = await invoke(
          {
            action: 'protect',
            data: value.toString('base64'),
            entropy: entropy.toString('base64'),
          },
          signal,
        );
        if (!/^[a-zA-Z0-9+/=]+$/.test(raw) || raw.length > 44000)
          throw unavailable();
        cipher = Buffer.from(raw, 'base64');
        if (signal.aborted) throw unavailable();
        await assertNoLinks(path, true);
        const file = await open(path, 'wx', 0o600);
        try {
          await file.writeFile(cipher);
          await file.sync();
        } finally {
          await file.close();
        }
      } finally {
        entropy.fill(0);
        cipher?.fill(0);
      }
    },
    async read(id, signal) {
      const cipher = await encrypted(id);
      if (!cipher) throw unavailable();
      const entropy = entropyFor(id);
      try {
        const raw = await invoke(
          {
            action: 'unprotect',
            data: cipher.toString('base64'),
            entropy: entropy.toString('base64'),
          },
          signal,
        );
        if (!/^[a-zA-Z0-9+/=]+$/.test(raw)) throw unavailable();
        const result = Buffer.from(raw, 'base64');
        try {
          assertSecretValue(result);
          if (signal.aborted) throw unavailable();
          return result;
        } catch {
          result.fill(0);
          throw unavailable();
        }
      } finally {
        entropy.fill(0);
        cipher.fill(0);
      }
    },
    async delete(id) {
      if (readOnly) throw unavailable();
      const before = await encrypted(id);
      if (!before) return;
      try {
        const after = await encrypted(id);
        try {
          if (!after?.equals(before)) throw unavailable();
          await unlink(pathFor(id));
        } finally {
          after?.fill(0);
        }
      } finally {
        before.fill(0);
      }
    },
  };
}
