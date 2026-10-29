import type { ProcessRunner } from '../../ports.js';
import type { DockerCommand } from '../docker-profile.js';
import {
  assertSecretId,
  assertSecretValue,
  type SecretBackend,
} from '../../auth/secrets.js';
import { HubError } from '../../errors.js';

// Docker 0.44.2 exposes stdin set / metadata ls --json / scoped rm. There is NO
// documented plaintext read, so this adapter intentionally has no read method.
export function dockerSecretStore(
  command: DockerCommand,
  runner: ProcessRunner,
): SecretBackend {
  async function has(id: string, signal: AbortSignal) {
    assertSecretId(id);
    const items: unknown = JSON.parse(
      await command.run(['mcp', 'secret', 'ls', '--json'], signal),
    );
    if (
      !Array.isArray(items) ||
      items.length > 4096 ||
      items.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          typeof (item as { name?: unknown }).name !== 'string',
      )
    )
      throw new HubError(
        'unavailable',
        'Docker secret metadata is unsupported.',
      );
    return items.some((item: { name: string }) => item.name === id);
  }
  return {
    has,
    async put(id, value, signal) {
      assertSecretId(id);
      assertSecretValue(value);
      if (await has(id, signal))
        throw new HubError(
          'conflict',
          'Use a fresh generated secret identifier.',
        );
      const result = await runner.run({
        executable: command.executable,
        arguments: ['mcp', 'secret', 'set', id],
        environment: { ...command.environment },
        stdin: value.toString('utf8'),
        signal,
        timeoutMs: 10_000,
        outputLimitBytes: 64 * 1024,
      });
      if (
        result.outcome !== 'exited' ||
        result.exitCode !== 0 ||
        !(await has(id, signal))
      )
        throw new HubError(
          'unavailable',
          'Docker secret write could not be verified.',
        );
    },
    async delete(id, signal) {
      assertSecretId(id);
      if (!(await has(id, signal))) return;
      // A CLI can remove an owned value and then fail while finalizing. Exact
      // metadata read-back, not the exit status alone, determines absence.
      await command
        .run(['mcp', 'secret', 'rm', id], signal)
        .catch(() => undefined);
      if (await has(id, signal))
        throw new HubError(
          'unavailable',
          'Docker secret deletion could not be verified.',
        );
    },
  };
}
