import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connector } from '@waleed/contracts';
import { createWindowsDiscoveryPorts } from '../adapters/discovery-files.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import { dockerCommand } from '../adapters/docker-profile.js';
import { ContainedStdioTransport } from '../adapters/mcp/stdio.js';
import { cleanupOwnedContainers } from '../adapters/mcp/container-cleanup.js';
import { assertNoLinks } from '../adapters/managed-files.js';

export async function dockerAgentTransport(
  connector: Extract<Connector, { executionMode: 'docker' }>,
  directory: string,
  signal: AbortSignal,
) {
  if (Object.keys(connector.secretBindings).length)
    throw new Error('Keychain gateway recipe unavailable.');
  const [executable] = await createWindowsDiscoveryPorts({
    workingDirectory: directory,
    environment: process.env,
  }).find(['docker'], signal);
  if (!executable) throw new Error();
  const runner = await createWindowsProcessRunner({
    allowedExecutables: [executable],
    workingDirectory: directory,
    concurrency: 1,
  });
  const docker = dockerCommand(
    runner,
    executable,
    Object.fromEntries(
      Object.entries(process.env).filter(
        (item): item is [string, string] => item[1] !== undefined,
      ),
    ),
  );
  await docker.run(['version', '--format', '{{.Server.Version}}'], signal);
  const root = join(directory, 'owned-agent-containers');
  await assertNoLinks(root, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertNoLinks(root);
  if ((await readdir(root)).length)
    throw new Error('Owned container recovery is pending.');
  const nonce = randomUUID(),
    path = join(root, `wmh-${nonce}.json`);
  const marker = await open(path, 'wx', 0o600);
  try {
    await marker.writeFile(
      JSON.stringify({ nonce, connectorId: connector.id }),
    );
    await marker.sync();
  } finally {
    await marker.close();
  }
  const controller = new AbortController();
  const transport = new ContainedStdioTransport(
    runner,
    {
      executable,
      arguments: [
        'run',
        '--rm',
        '--interactive',
        '--pull=missing',
        '--label',
        `wmh.client=${nonce}`,
        '--label',
        `wmh.connector=${connector.id}`,
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
      environment: { ...docker.environment },
      timeoutMs: 120000,
      outputLimitBytes: 1024 * 1024,
    },
    AbortSignal.any([signal, controller.signal]),
  );
  return {
    transport,
    async dispose() {
      controller.abort();
      try {
        await transport.close();
      } finally {
        await cleanupOwnedContainers(docker, nonce, connector.id);
      }
      await unlink(path);
    },
  };
}
