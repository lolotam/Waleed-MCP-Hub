import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { createWindowsProcessRunner } from './native/process-runner.js';
import type { DiscoveryPorts, ReadResult } from '../discovery/ports.js';
import type { ProcessRunner } from '../ports.js';
import { HubError } from '../errors.js';

const local = (path: string) =>
  /^[a-z]:[\\/]/i.test(path) &&
  !/[\0\r\n]/.test(path) &&
  !path.slice(2).includes(':');
const privateCaches = new Set([
  'auth.json',
  '.auth.json',
  'credentials.json',
  '.credentials.json',
]);

// Known-file, bounded, read-only adapter. No write method, shell evaluation,
// variable expansion, plugin loading, or credential-cache interface exists.
export function createWindowsDiscoveryPorts(options: {
  workingDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
}): DiscoveryPorts {
  const runners = new Map<string, Promise<ProcessRunner>>();
  const pathValue =
    Object.entries(options.environment).find(
      ([key]) => key.toLowerCase() === 'path',
    )?.[1] ?? '';
  const directories = [
    ...new Set(
      pathValue
        .split(';')
        .map((path) => path.replace(/^"|"$/g, ''))
        .filter(local),
    ),
  ].slice(0, 128);
  async function safeFile(path: string) {
    if (!local(path) || privateCaches.has(win32.basename(path).toLowerCase()))
      return false;
    const parsed = win32.parse(win32.normalize(path));
    let current = parsed.root;
    for (const part of win32
      .relative(parsed.root, win32.normalize(path))
      .split(win32.sep)) {
      current = win32.join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
    }
    return (await lstat(path)).isFile();
  }
  return {
    async find(names, signal) {
      const found: string[] = [];
      let inaccessible = false;
      for (const name of names) {
        if (!/^[a-z][a-z0-9-]{0,40}$/i.test(name)) continue;
        for (const directory of directories) {
          for (const extension of ['.exe', '.cmd', '.ps1']) {
            if (signal.aborted) return found;
            const path = win32.join(directory, name + extension);
            try {
              if (await safeFile(path)) {
                found.push(await realpath(path));
                break;
              }
            } catch (error) {
              if (
                !['ENOENT', 'ENOTDIR'].includes(
                  (error as NodeJS.ErrnoException).code ?? '',
                )
              )
                inaccessible = true;
            }
          }
          if (
            found.some(
              (path) =>
                win32.basename(path, win32.extname(path)).toLowerCase() ===
                name.toLowerCase(),
            )
          )
            break;
        }
      }
      if (!found.length && inaccessible)
        throw new HubError(
          'unavailable',
          'Executable search could not be completed safely.',
        );
      return [
        ...new Map(found.map((path) => [path.toLowerCase(), path])).values(),
      ];
    },
    async read(path, signal): Promise<ReadResult> {
      if (signal.aborted || !local(path)) return { status: 'unsafe' };
      try {
        if (!(await safeFile(path))) return { status: 'unsafe' };
        const file = await open(path, 'r');
        try {
          const limit = 1024 * 1024;
          const buffer = Buffer.alloc(limit + 1);
          let offset = 0;
          while (offset < buffer.length && !signal.aborted) {
            const { bytesRead } = await file.read(
              buffer,
              offset,
              buffer.length - offset,
              offset,
            );
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (signal.aborted) return { status: 'unsafe' };
          if (offset > limit) return { status: 'too_large' };
          const bytes = buffer.subarray(0, offset);
          return {
            status: 'read',
            text: bytes.toString('utf8').replace(/^\uFEFF/, ''),
            fingerprint: createHash('sha256').update(bytes).digest('hex'),
          };
        } finally {
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
      if (
        signal.aborted ||
        !local(executable) ||
        win32.extname(executable).toLowerCase() !== '.exe'
      )
        return { ok: false, output: '' };
      try {
        if (!runners.has(executable))
          runners.set(
            executable,
            createWindowsProcessRunner({
              allowedExecutables: [executable],
              workingDirectory: options.workingDirectory,
            }),
          );
        const runner = await runners.get(executable)!;
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
