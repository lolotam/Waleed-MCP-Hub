import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Connector } from '@waleed/contracts';
import { createWindowsDiscoveryPorts } from '../adapters/discovery-files.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import {
  dockerCommand,
  type DockerCommand,
} from '../adapters/docker-profile.js';
import { ContainedStdioTransport } from '../adapters/mcp/stdio.js';
import { cleanupOwnedContainers } from '../adapters/mcp/container-cleanup.js';
import { assertNoLinks, managedFiles } from '../adapters/managed-files.js';
import { dockerSecretStore } from '../adapters/secrets/docker.js';
import type { SecretBackend } from '../auth/secrets.js';
import type { SecretLease } from '../auth/bindings.js';
import type { ProcessRunner } from '../ports.js';
import { hashBytes } from '../runtime/registry.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import { bridgeSessionLimits } from './peer-sessions.js';

type DockerConnector = Extract<Connector, { executionMode: 'docker' }>;
type ResolveBindings = (backend: SecretBackend) => Promise<SecretLease>;
// Active artifacts in this bridge are not failed recovery. Foreign/stale files
// still fail closed; never delete or adopt another bridge's markers.
const activeArtifacts = new Set<string>();

// Gateway 0.44.2 assigns these labels from the isolated catalog server name.
// Never select containers by image or inspect their credential-bearing environment.
export async function cleanupGatewayContainers(
  docker: DockerCommand,
  server: string,
) {
  try {
    if (!/^wmh-[a-f0-9-]{36}$/.test(server)) throw new Error();
    const signal = AbortSignal.timeout(30_000);
    const list = [
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=docker-mcp-name=${server}`,
    ];
    const raw = await docker.run(list, signal);
    const ids = raw.trim() ? raw.trim().split(/\s+/) : [];
    if (ids.length > 16 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
      throw new Error();
    for (const id of ids) {
      const labels: unknown = JSON.parse(
        await docker.run(
          ['inspect', '--format', '{{json .Config.Labels}}', id],
          signal,
        ),
      );
      if (
        !labels ||
        typeof labels !== 'object' ||
        (labels as Record<string, unknown>)['docker-mcp-name'] !== server ||
        (labels as Record<string, unknown>)['docker-mcp'] !== 'true' ||
        (labels as Record<string, unknown>)['docker-mcp-tool-type'] !== 'mcp' ||
        (labels as Record<string, unknown>)['docker-mcp-transport'] !== 'stdio'
      )
        throw new Error();
      await docker.run(['rm', '--force', id], signal);
    }
    if ((await docker.run(list, signal)).trim()) throw new Error();
  } catch {
    throw new RuntimeFault('dependency_unavailable', true);
  }
}

export async function dockerAgentTransport(
  connector: DockerConnector,
  directory: string,
  signal: AbortSignal,
  resolveBindings?: ResolveBindings,
) {
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
  return createDockerAgentTransport({
    connector,
    directory,
    signal,
    docker,
    runner,
    catalogDirectory: join(homedir(), '.docker', 'mcp', 'catalogs'),
    ...(resolveBindings ? { resolveBindings } : {}),
  });
}

// Internal seam: tests use a synthetic Docker command/duplex runner and owned files.
export async function createDockerAgentTransport(options: {
  connector: DockerConnector;
  directory: string;
  catalogDirectory: string;
  signal: AbortSignal;
  docker: DockerCommand;
  runner: ProcessRunner;
  resolveBindings?: ResolveBindings;
}) {
  const { connector, directory, signal, docker, runner } = options;
  const bound = Object.keys(connector.secretBindings).length > 0;
  if (Object.keys(connector.headerBindings).length)
    throw new RuntimeFault('secrets_pending');
  // Gateway templates/variable expansion must not reinterpret approved literal argv.
  if (
    bound &&
    (connector.portBindings?.length ||
      /,/.test(directory + options.catalogDirectory) ||
      [
        ...(connector.command ?? []),
        ...connector.arguments,
        ...Object.values(connector.environmentLiterals ?? {}),
      ].some((value) => /\$|\{\{|\}\}/.test(value)))
  )
    throw new RuntimeFault('adapter_pending');
  await docker.run(['version', '--format', '{{.Server.Version}}'], signal);
  let lease: SecretLease | undefined;
  if (bound) {
    if (!options.resolveBindings) throw new RuntimeFault('secrets_pending');
    lease = await options.resolveBindings(dockerSecretStore(docker, runner));
    if (
      Object.keys(lease.environment).length ||
      Object.keys(lease.headers).length ||
      lease.dockerSecrets?.length !==
        Object.keys(connector.secretBindings).length ||
      Object.entries(connector.secretBindings).some(
        ([env, name]) =>
          !lease!.dockerSecrets!.some(
            (secret) => secret.env === env && secret.name === name,
          ),
      )
    ) {
      lease.dispose();
      throw new RuntimeFault('secrets_pending');
    }
  }
  try {
    return await prepareTransport();
  } catch (error) {
    lease?.dispose();
    throw error;
  }
  async function prepareTransport() {
    const root = join(directory, 'owned-agent-containers');
    await assertNoLinks(root, true);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertNoLinks(root);
    if (
      (await readdir(root)).some(
        (name) => !activeArtifacts.has(join(root, name)),
      )
    )
      throw new Error('Owned container recovery is pending.');
    const nonce = randomUUID(),
      path = join(root, `wmh-${nonce}.json`);
    const server = `wmh-${nonce}`;
    activeArtifacts.add(path);
    try {
      const marker = await open(path, 'wx', 0o600);
      try {
        await marker.writeFile(
          JSON.stringify({
            nonce,
            connectorId: connector.id,
            ...(bound ? { gatewayServer: server } : {}),
          }),
        );
        await marker.sync();
      } finally {
        await marker.close();
      }
    } catch (error) {
      activeArtifacts.delete(path);
      throw error;
    }
    const controller = new AbortController();
    const files = managedFiles({
      runtime: root,
      catalog: options.catalogDirectory,
    });
    const catalogName = `${server}.json`,
      configName = `wmh-${randomUUID()}.json`;
    const configPath = files.path('runtime', configName);
    const catalog = JSON.stringify({
      name: server,
      registry: {
        [server]: {
          name: server,
          type: 'server',
          longLived: true,
          // Stable across per-request nonces, even with Docker's tool-name-prefix
          // feature enabled. Cached bridge routes must work after reconnecting.
          prefix: 'wmh',
          image: connector.image,
          command: [...(connector.command ?? []), ...connector.arguments],
          env: Object.entries(connector.environmentLiterals ?? {}).map(
            ([name, value]) => ({ name, value }),
          ),
          secrets: lease?.dockerSecrets,
          remote: {},
        },
      },
    });
    const emptyConfig = '{}\n';
    const writes: Array<{
      scope: 'catalog' | 'runtime';
      name: string;
      contents: string;
    }> = [];
    let catalogAttempted = false;
    const cleanupFiles = async () => {
      // Even a post-write adapter failure can leave a file. Exact hashes protect drift.
      if (catalogAttempted)
        await files.write('catalog', catalogName, hashBytes(catalog), null);
      for (const file of writes.reverse())
        await files.write(
          file.scope,
          file.name,
          hashBytes(file.contents),
          null,
        );
      await unlink(path);
    };
    try {
      if (bound) {
        activeArtifacts.add(configPath);
        writes.push({
          scope: 'runtime',
          name: configName,
          contents: emptyConfig,
        });
        await files.write('runtime', configName, null, emptyConfig);
        catalogAttempted = true;
        await files.write('catalog', catalogName, null, catalog);
      }
    } catch {
      // Missing files from a pre-commit failure need no compensation; existing files
      // must match the exact owned content before removal.
      try {
        if (
          catalogAttempted &&
          (await files.read('catalog', catalogName)) === null
        )
          catalogAttempted = false;
        for (let i = writes.length - 1; i >= 0; i--)
          if ((await files.read(writes[i]!.scope, writes[i]!.name)) === null)
            writes.splice(i, 1);
        await cleanupFiles();
      } finally {
        activeArtifacts.delete(path);
        activeArtifacts.delete(configPath);
      }
      throw new RuntimeFault('dependency_unavailable');
    }
    const transport = new ContainedStdioTransport(
      runner,
      {
        executable: docker.executable,
        arguments: bound
          ? [
              'mcp',
              'gateway',
              'run',
              '--catalog',
              files.path('catalog', catalogName),
              '--servers',
              server,
              '--config',
              files.path('runtime', configName),
              '--tools-config',
              files.path('runtime', configName),
              '--registry',
              files.path('runtime', configName),
              '--secrets=docker-desktop',
              '--transport=stdio',
              '--watch=false',
              '--long-lived',
              '--log-calls=false',
              '--block-secrets=true',
              '--cpus=1',
              '--memory=512m',
            ]
          : [
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
        timeoutMs: bridgeSessionLimits.maxLifetimeMs,
        session: true,
        outputLimitBytes: 1024 * 1024,
      },
      AbortSignal.any([signal, controller.signal]),
    );
    let disposing: Promise<void> | undefined;
    return {
      transport,
      dispose() {
        return (disposing ??= (async () => {
          try {
            await transport.close();
          } finally {
            controller.abort();
            try {
              if (bound) await cleanupGatewayContainers(docker, server);
              else await cleanupOwnedContainers(docker, nonce, connector.id);
              await cleanupFiles();
            } finally {
              activeArtifacts.delete(path);
              activeArtifacts.delete(configPath);
              lease?.dispose();
            }
          }
        })());
      },
    };
  }
}
