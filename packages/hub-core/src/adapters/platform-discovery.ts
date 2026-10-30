import { access, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { createWindowsDiscoveryPorts } from './discovery-files.js';
import { createPlatformProcessRunner } from './native/platform-runner.js';
import { assertNoLinks } from './managed-files.js';
import type { DiscoveryPorts } from '../discovery/ports.js';
import { supportedPlatform } from '../platform/paths.js';

export function createPlatformDiscoveryPorts(options: {
  workingDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
}): DiscoveryPorts {
  if (supportedPlatform(process.platform) === 'win32')
    return createWindowsDiscoveryPorts(options);
  const directories = [
    ...new Set(
      (options.environment.PATH ?? '')
        .split(':')
        .filter((path) => posix.isAbsolute(path) && !/[\0\r\n]/.test(path)),
    ),
  ].slice(0, 128);
  return {
    async find(names, signal) {
      const found: string[] = [];
      for (const name of names) {
        if (!/^[a-z][a-z0-9-]{0,40}$/i.test(name)) continue;
        for (const directory of directories) {
          signal.throwIfAborted();
          const path = posix.join(directory, name);
          try {
            const canonical = await realpath(path);
            if (!(await lstat(canonical)).isFile()) continue;
            await access(canonical, constants.X_OK);
            found.push(canonical);
            break;
          } catch (error) {
            if (
              !['ENOENT', 'ENOTDIR', 'EACCES'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error;
          }
        }
      }
      return [...new Set(found)];
    },
    async read(path, signal) {
      if (
        signal.aborted ||
        !posix.isAbsolute(path) ||
        /^(?:\.?auth|\.?credentials)\.json$/i.test(posix.basename(path))
      )
        return { status: 'unsafe' };
      try {
        await assertNoLinks(path);
        const info = await lstat(path);
        if (!info.isFile() || info.nlink !== 1) return { status: 'unsafe' };
        if (info.size > 1024 * 1024) return { status: 'too_large' };
        const file = await open(path, 'r');
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        try {
          const opened = await file.stat();
          if (
            opened.ino !== info.ino ||
            opened.dev !== info.dev ||
            opened.nlink !== 1 ||
            !opened.isFile()
          )
            return { status: 'unsafe' };
          let length = 0;
          while (length < buffer.length && !signal.aborted) {
            const { bytesRead } = await file.read(
              buffer,
              length,
              buffer.length - length,
              length,
            );
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length > 1024 * 1024) return { status: 'too_large' };
          if (signal.aborted) return { status: 'unsafe' };
          const bytes = buffer.subarray(0, length);
          return {
            status: 'read',
            text: bytes.toString('utf8').replace(/^\uFEFF/, ''),
            fingerprint: createHash('sha256').update(bytes).digest('hex'),
          };
        } finally {
          buffer.fill(0);
          await file.close();
        }
      } catch (error) {
        return {
          status:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'missing'
              : 'inaccessible',
        };
      }
    },
    async run(executable, arguments_, environment, signal) {
      try {
        const runner = await createPlatformProcessRunner({
          allowedExecutables: [executable],
          workingDirectory: options.workingDirectory,
        });
        const result = await runner.run({
          executable,
          arguments: arguments_,
          environment,
          signal,
          timeoutMs: 8000,
          outputLimitBytes: 1024 * 1024,
        });
        return {
          ok: result.outcome === 'exited' && result.exitCode === 0,
          output:
            result.outcome === 'exited' && result.exitCode === 0
              ? result.stdout
              : '',
        };
      } catch {
        return { ok: false, output: '' };
      }
    },
  };
}
