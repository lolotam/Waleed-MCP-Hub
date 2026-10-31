import type { Connector } from '@waleed/contracts';
import { createWindowsDiscoveryPorts } from '../adapters/discovery-files.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import { dockerCommand } from '../adapters/docker-profile.js';
import { ContainedStdioTransport } from '../adapters/mcp/stdio.js';
import type { ProcessResult, ProcessRunner } from '../ports.js';
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

// The short commands of one bridge wait for a free slot of their runner
// instead of failing: an image pull or a recovery round never turns a busy
// runner into an unavailable daemon. The wait counts against the command's
// own timeout, and an abort ends it.
// The shortest timeout the process runner accepts: a command whose wait
// left less than this has timed out.
const MIN_RUNNER_TIMEOUT_MS = 50;

export function queuedRunner(
  runner: ProcessRunner,
  slots: number,
): ProcessRunner {
  let active = 0;
  const waiting: Array<() => void> = [];
  const empty = (outcome: ProcessResult['outcome']): ProcessResult => ({
    exitCode: null,
    stdout: '',
    stderr: '',
    outcome,
  });
  // A finished command hands its slot to the next waiting one.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return {
    async run(request) {
      const queuedAt = Date.now();
      if (request.signal.aborted) return empty('cancelled');
      if (active < slots) active++;
      else {
        const admitted = await new Promise<boolean>((resolve) => {
          const leave = (value: boolean) => {
            clearTimeout(timer);
            request.signal.removeEventListener('abort', cancel);
            const index = waiting.indexOf(turn);
            if (index !== -1) waiting.splice(index, 1);
            resolve(value);
          };
          const turn = () => leave(true);
          const cancel = () => leave(false);
          const timer = setTimeout(cancel, request.timeoutMs);
          waiting.push(turn);
          request.signal.addEventListener('abort', cancel, { once: true });
        });
        if (!admitted)
          return empty(request.signal.aborted ? 'cancelled' : 'timed_out');
      }
      try {
        const remaining = request.timeoutMs - (Date.now() - queuedAt);
        if (remaining < MIN_RUNNER_TIMEOUT_MS) return empty('timed_out');
        return await runner.run({ ...request, timeoutMs: remaining });
      } finally {
        release();
      }
    },
  };
}

// The lanes of the short commands of one bridge: an image pull of the
// pre-flight runs up to ten minutes, so it waits in a lane of its own. A
// pull never takes the slot of a removal, an inspection or a recovery
// round, and those always keep their own capacity.
export function laneRunner(
  runner: ProcessRunner,
  shortSlots: number,
  pullSlots: number,
): ProcessRunner {
  const short = queuedRunner(runner, shortSlots);
  const pulls = queuedRunner(runner, pullSlots);
  return {
    run: (request) =>
      (request.arguments[0] === 'pull' ? pulls : short).run(request),
  };
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
  // that stays alive never blocks a recovery. They queue for two slots of
  // their own, and the image pulls queue for a third one.
  const commandRunner = laneRunner(
    await createWindowsProcessRunner({
      allowedExecutables: [executable],
      workingDirectory: directory,
      concurrency: 3,
      // The image pull of the pre-flight is the longest command.
      maxTimeoutMs: 600_000,
    }),
    2,
    1,
  );
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
