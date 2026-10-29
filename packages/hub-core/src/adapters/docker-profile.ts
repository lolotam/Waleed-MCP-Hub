import type { ProcessRunner } from '../ports.js';
import type { ManagedFiles } from './managed-files.js';
import { HubError } from '../errors.js';
import { hashBytes } from '../runtime/registry.js';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

export interface DockerProfiles {
  read(id: string, signal: AbortSignal): Promise<string | null>;
  import(id: string, json: string, signal: AbortSignal): Promise<void>;
  remove(id: string, signal: AbortSignal): Promise<void>;
}
export interface DockerCommand {
  executable: string;
  environment: Record<string, string>;
  run(args: readonly string[], signal: AbortSignal): Promise<string>;
}
export function dockerCommand(
  runner: ProcessRunner,
  executable: string,
  declared: Record<string, string>,
): DockerCommand {
  const environment: Record<string, string> = {};
  // Docker's keychain interface invokes its own credential helper by name.
  // Provide only reviewed binary directories, never the user's inherited PATH.
  environment.PATH = [
    win32.dirname(executable),
    win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  ].join(';');
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMW6432',
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
  ])
    if (declared[key]) environment[key] = declared[key]!;
  let ready: Promise<void> | undefined;
  const execute = async (args: readonly string[], signal: AbortSignal) => {
    const result = await runner.run({
      executable,
      arguments: args,
      environment,
      signal,
      timeoutMs: 8000,
      outputLimitBytes: 1024 * 1024,
    });
    if (result.outcome !== 'exited' || result.exitCode !== 0)
      throw new HubError(
        'unavailable',
        'Docker command failed; no raw provider diagnostics are returned.',
      );
    return result.stdout;
  };
  return {
    executable,
    environment,
    async run(args, signal) {
      if (!ready)
        ready = (async () => {
          if (
            environment.DOCKER_CONFIG &&
            (!/^[a-z]:[\\/]/i.test(environment.DOCKER_CONFIG) ||
              environment.DOCKER_CONFIG.slice(2).includes(':'))
          )
            throw new HubError(
              'invalid',
              'Only a local Docker configuration is supported.',
            );
          const host: unknown =
            environment.DOCKER_HOST && !environment.DOCKER_CONTEXT
              ? environment.DOCKER_HOST
              : JSON.parse(
                  await execute(
                    [
                      'context',
                      'inspect',
                      '--format',
                      '{{json .Endpoints.docker.Host}}',
                    ],
                    signal,
                  ),
                );
          if (
            typeof host !== 'string' ||
            !/^npipe:\/\/\/\/\.\/pipe\/[a-z0-9._-]+$/i.test(host)
          )
            throw new HubError(
              'invalid',
              'Only verified local Docker named-pipe contexts are supported.',
            );
          environment.DOCKER_HOST = host;
          environment.DOCKER_CONTEXT = '';
          if (
            (await execute(['mcp', 'version'], signal))
              .trim()
              .replace(/^v/, '') !== '0.44.2'
          )
            throw new HubError(
              'unavailable',
              'Docker MCP gateway version is unsupported.',
            );
        })().catch((error: unknown) => {
          ready = undefined;
          throw error;
        });
      await ready;
      return execute(args, signal);
    },
  };
}
export function dockerProfiles(
  command: DockerCommand,
  files: ManagedFiles,
): DockerProfiles {
  const valid = (id: string) => {
    if (!/^wmh-[a-f0-9]{24}$/.test(id))
      throw new HubError(
        'invalid',
        'Only this manager’s isolated profile IDs may be written.',
      );
  };
  return {
    async read(id, signal) {
      valid(id);
      const list: unknown = JSON.parse(
        await command.run(
          ['mcp', 'profile', 'list', '--format', 'json'],
          signal,
        ),
      );
      if (
        !Array.isArray(list) ||
        list.length > 256 ||
        list.some(
          (entry) =>
            !entry ||
            typeof entry !== 'object' ||
            typeof (entry as { id?: unknown }).id !== 'string',
        )
      )
        throw new HubError(
          'unavailable',
          'Docker profile list format is unsupported.',
        );
      if (!list.some((entry: { id: string }) => entry.id === id)) return null;
      return command.run(
        ['mcp', 'profile', 'show', id, '--format', 'json'],
        signal,
      );
    },
    async import(id, json, signal) {
      valid(id);
      const parsed: unknown = JSON.parse(json);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { id?: unknown }).id !== id
      )
        throw new HubError(
          'invalid',
          'Docker profile input identifier mismatch.',
        );
      const name = `wmh-${randomUUID()}.json`;
      await files.write('runtime', name, null, json);
      try {
        await command.run(
          ['mcp', 'profile', 'import', files.path('runtime', name)],
          signal,
        );
      } finally {
        await files.write('runtime', name, hashBytes(json), null);
      }
    },
    async remove(id, signal) {
      valid(id);
      await command.run(['mcp', 'profile', 'remove', id], signal);
    },
  };
}
