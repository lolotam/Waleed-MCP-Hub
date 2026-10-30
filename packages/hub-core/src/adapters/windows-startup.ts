import { join, resolve, win32 } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StartupStatusSchema } from '@waleed/contracts';
import { assertNoLinks } from './managed-files.js';
import { createWindowsProcessRunner } from './native/process-runner.js';
import type { StartupRegistration } from '../runtime/lifecycle-settings.js';
import { HubError } from '../errors.js';

// Construction-only root, never an HTTP path. The manifest is build identity,
// not code signing or protection against malicious same-user file replacement.
export function windowsStartupRegistration(root: string): StartupRegistration {
  const launcher = join(root, 'WaleedMcpHub.exe'),
    manifest = join(root, 'WaleedMcpHub.launcher.json');
  const verify = async () => {
    if (
      process.platform !== 'win32' ||
      !win32.isAbsolute(root) ||
      resolve(root) !== root ||
      /["\r\n\0]/.test(root)
    )
      throw new Error();
    for (const file of [root, launcher, manifest]) await assertNoLinks(file);
    const info = await lstat(launcher),
      meta = await lstat(manifest);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 4 * 1024 * 1024 ||
      !meta.isFile() ||
      meta.nlink !== 1 ||
      meta.size > 1024
    )
      throw new Error();
    const value = JSON.parse(await readFile(manifest, 'utf8')) as {
      protocol?: unknown;
      sha256?: unknown;
      sourceSha256?: unknown;
    };
    const hash = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex');
    if (
      value.protocol !== 'wmh-launcher-v1' ||
      value.sha256 !== hash(await readFile(launcher)) ||
      value.sourceSha256 !==
        hash(await readFile(join(root, 'scripts', 'WaleedMcpHub.cs')))
    )
      throw new Error();
  };
  const execute = async (command: string) => {
    await verify();
    const runner = await createWindowsProcessRunner({
      allowedExecutables: [launcher],
      workingDirectory: root,
      concurrency: 1,
    });
    const result = await runner.run({
      executable: launcher,
      arguments: [command],
      environment: {},
      timeoutMs: 10000,
      outputLimitBytes: 2048,
      signal: AbortSignal.timeout(12000),
    });
    if (result.outcome !== 'exited' || result.exitCode !== 0)
      throw new HubError('conflict', 'Startup registration was not confirmed.');
    return StartupStatusSchema.parse(JSON.parse(result.stdout));
  };
  return {
    async query() {
      try {
        return await execute('--startup-query');
      } catch {
        return { available: false, state: 'unavailable', enabled: false };
      }
    },
    async set(enabled, expectedState) {
      if (
        typeof enabled !== 'boolean' ||
        !['enabled', 'disabled'].includes(expectedState)
      )
        throw new HubError('invalid', 'Unsupported startup change.');
      return execute(
        `--startup-${enabled ? 'enable' : 'disable'}-from-${expectedState}`,
      );
    },
  };
}
