import type { Connector } from '@waleed/contracts';
import { createWindowsDiscoveryPorts } from '../adapters/discovery-files.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import { dockerCommand } from '../adapters/docker-profile.js';
import { ContainedStdioTransport } from '../adapters/mcp/stdio.js';
import type { ProcessRunner } from '../ports.js';
import type { DockerOwnership } from './docker-ownership.js';

// The Docker CLI of one bridge: the executable, the runner of the short
// commands and the factory of the session runners.
export interface DockerSession {
  executable: string;
  command: ReturnType<typeof dockerCommand>;
  // The clock of the bridge: the cleanup of a peer runs on the budget that
  // is left of the shutdown, and the bridge owns that clock.
  now?: () => number;
  // The session runner of one container: every pooled peer owns its own
  // runner, so the pool's capacity and not a shared runner's concurrency
  // bounds the Docker peers.
  createRunner(): Promise<ProcessRunner>;
}

export async function createDockerSession(
  directory: string,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<DockerSession> {
  const [executable] = await createWindowsDiscoveryPorts({
    workingDirectory: directory,
    environment: process.env,
  }).find(['docker'], signal);
  if (!executable) throw new Error();
  // The short commands of the daemon run in their own runner: a container
  // that stays alive never blocks a recovery.
  const commandRunner = await createWindowsProcessRunner({
    allowedExecutables: [executable],
    workingDirectory: directory,
    concurrency: 2,
    // The image pull of the pre-flight is the longest command.
    maxTimeoutMs: 600_000,
  });
  const command = dockerCommand(
    commandRunner,
    executable,
    Object.fromEntries(
      Object.entries(process.env).filter(
        (item): item is [string, string] => item[1] !== undefined,
      ),
    ),
  );
  return {
    executable,
    command,
    now,
    async createRunner() {
      // One runner per pooled peer, as every native session peer has.
      return createWindowsProcessRunner({
        allowedExecutables: [executable],
        workingDirectory: directory,
        concurrency: 1,
        // A pooled container keeps its CLI for the whole session.
        session: true,
        maxTimeoutMs: 3_660_000,
      });
    },
  };
}

// The budget of one cleanup: the remaining deadline of the shutdown
// sequence, or the ordinary bound of a disposal that is not a shutdown.
const cleanupSignal = (deadline?: number, now: () => number = Date.now) =>
  AbortSignal.timeout(
    deadline === undefined ? 4000 : Math.max(0, deadline - now()),
  );

// The transport of one container session. The ownership module names the
// container id file and the ownership labels of the run.
export async function dockerAgentTransport(
  connector: Extract<Connector, { executionMode: 'docker' }>,
  signal: AbortSignal,
  session: DockerSession,
  ownership: DockerOwnership,
) {
  // A Docker connector that needs protected values is refused: the header
  // and the secret bindings are never resolved for a container.
  if (
    Object.keys(connector.secretBindings).length ||
    Object.keys(connector.headerBindings).length
  )
    throw new Error('Keychain gateway recipe unavailable.');
  const controller = new AbortController();
  let transport: ContainedStdioTransport | undefined;
  // The peer owns its runner: a shared runner would refuse the fifth
  // container of a pool.
  const runner = await session.createRunner();
  const launch = await ownership.launch(
    {
      connectorId: connector.id,
      image: connector.image,
      async start(labels, cidfilePath) {
        transport = new ContainedStdioTransport(
          runner,
          {
            executable: session.executable,
            arguments: [
              'run',
              '--rm',
              '--interactive',
              // The image was pulled by the pre-flight of the launch.
              '--pull=never',
              ...labels,
              '--cidfile',
              cidfilePath,
              '--memory',
              '512m',
              '--cpus',
              '1',
              ...(connector.portBindings ?? []).flatMap((port) => [
                '--publish',
                `127.0.0.1:${port.host}:${port.container}`,
              ]),
              ...Object.entries(connector.environmentLiterals ?? {}).flatMap(
                ([key, value]) => ['--env', `${key}=${value}`],
              ),
              connector.image,
              ...(connector.command ?? []),
              ...connector.arguments,
            ],
            environment: { ...session.command.environment },
            timeoutMs: 3_660_000,
            outputLimitBytes: 64 * 1024 * 1024,
            session: { inputLimitBytes: 16 * 1024 * 1024 },
          },
          AbortSignal.any([signal, controller.signal]),
        );
      },
    },
    signal,
  );
  // The container id file holds the immutable id once the container was
  // created: the marker moves to `running` then. A launch that never reaches
  // it stays `launching` and the recovery resolves it.
  void ownership.watch(launch, signal).catch(() => undefined);
  const container = transport!;
  return {
    transport: container,
    async dispose(deadline?: number) {
      controller.abort();
      try {
        await container.close();
      } finally {
        // The cleanup runs on the budget of the shutdown sequence: no fresh
        // bound is created here.
        await ownership.dispose(launch, cleanupSignal(deadline, session.now));
      }
    },
  };
}
