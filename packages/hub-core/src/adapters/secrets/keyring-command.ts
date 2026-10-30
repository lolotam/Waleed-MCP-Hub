import { createPosixProcessRunner } from '../native/posix-runner.js';
import { HubError } from '../../errors.js';
import type { SecretCommandRunner } from './keyring.js';

export function keyringCommandRunner(
  directory: string,
  environment: Readonly<Record<string, string | undefined>>,
): SecretCommandRunner {
  const runners = new Map<
    string,
    ReturnType<typeof createPosixProcessRunner>
  >();
  return async (command) => {
    const retained: Buffer[] = [];
    try {
      if (!runners.has(command.executable))
        runners.set(
          command.executable,
          createPosixProcessRunner({
            workingDirectory: directory,
            allowedExecutables: [command.executable],
            concurrency: 2,
          }),
        );
      const runner = await runners.get(command.executable)!;
      const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C' };
      for (const key of [
        'HOME',
        'DBUS_SESSION_BUS_ADDRESS',
        'XDG_RUNTIME_DIR',
        'DISPLAY',
        'WAYLAND_DISPLAY',
      ])
        if (environment[key]) env[key] = environment[key]!;
      const result = await runner.run({
        executable: command.executable,
        arguments: command.arguments,
        environment: env,
        signal: command.signal,
        timeoutMs: 10_000,
        outputLimitBytes: 24 * 1024,
        stream: {
          started(write, endInput) {
            if (command.stdin) write(command.stdin.toString('utf8'));
            endInput?.();
          },
          stdout(chunk) {
            retained.push(Buffer.from(chunk));
          },
        },
      });
      if (result.outcome !== 'exited') throw new Error();
      const stdout = Buffer.concat(retained),
        stderr = Buffer.from(result.stderr);
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        dispose() {
          stdout.fill(0);
          stderr.fill(0);
        },
      };
    } catch {
      throw new HubError(
        'unavailable',
        'The system keyring command could not complete.',
      );
    } finally {
      retained.forEach((chunk) => chunk.fill(0));
    }
  };
}
