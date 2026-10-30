import { join } from 'node:path';
import { localClientTokenStore } from './http-tokens.js';
import { homedir } from 'node:os';
import { createWindowsDiscoveryPorts } from './discovery-files.js';
import { createWindowsProcessRunner } from './native/process-runner.js';
import { managedFiles } from './managed-files.js';
import {
  dockerCommand,
  dockerProfiles,
  type DockerCommand,
} from './docker-profile.js';
import { createMaterializer } from '../runtime/materialize.js';
import { createCapabilityRuntime } from './mcp/runtime.js';
import { localPackageRuntime } from './packages.js';
import { localMcpbAdapter } from './mcpb.js';
import type { LifecycleAdapters } from '../lifecycle.js';
import { StateSchema, type HubState } from '@waleed/contracts';
import { lstat, readFile } from 'node:fs/promises';
import { dockerSecretStore } from './secrets/docker.js';
import { createBindingResolver } from '../auth/bindings.js';
import type { SecretBackends } from '../auth/secrets.js';
import { assertNoLinks } from './managed-files.js';
import { windowsAgentTargets } from '../integrations/targets.js';
import { createManagedPeerFactory } from '../integrations/bridge.js';
import { agentFiles, outsideProtectedPilot } from '../integrations/files.js';
import { localLifecyclePreferences } from './lifecycle-settings.js';
import { createPlatformCredentialStorage } from './secrets/platform.js';
import { createPlatformDiscoveryPorts } from './platform-discovery.js';
import { platformAgentTargets } from '../integrations/targets.js';
import { supportedPlatform } from '../platform/paths.js';

export async function localRuntimeAdapters(
  directory: string,
  environment: Record<string, string | undefined>,
  readState?: () => Promise<HubState>,
): Promise<LifecycleAdapters> {
  const files = managedFiles({
    runtime: join(directory, 'managed'),
    catalog: join(
      environment.DOCKER_CONFIG ?? join(homedir(), '.docker'),
      'mcp',
      'catalogs',
    ),
  });
  let command: DockerCommand | undefined;
  const credentialStorage = createPlatformCredentialStorage({
    directory: join(directory, 'credentials'),
    environment,
  });
  const secrets: SecretBackends = { ...credentialStorage.backends };
  if (process.platform === 'win32') {
    try {
      const [executable] = await createWindowsDiscoveryPorts({
        workingDirectory: directory,
        environment,
      }).find(['docker'], AbortSignal.timeout(3000));
      if (executable?.toLowerCase().endsWith('.exe'))
        command = dockerCommand(
          await createWindowsProcessRunner({
            allowedExecutables: [executable],
            workingDirectory: directory,
          }),
          executable,
          Object.fromEntries(
            Object.entries(environment).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        );
    } catch {
      /* Startup stays degraded. No Docker command, import or connector starts here. */
    }
  }
  if (process.platform === 'win32') {
    if (command)
      secrets.docker = dockerSecretStore(
        command,
        await createWindowsProcessRunner({
          allowedExecutables: [command.executable],
          workingDirectory: directory,
        }),
      );
  }
  const registry =
    readState ??
    (async () => {
      const path = join(directory, 'state.json');
      await assertNoLinks(path);
      if ((await lstat(path)).size > 16 * 1024 * 1024)
        throw new Error('Registry exceeds limit.');
      return StateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    });
  return {
    credentialStorage,
    clientTokens: localClientTokenStore(directory),
    lifecyclePreferences: localLifecyclePreferences(directory),
    playgroundConnect: createManagedPeerFactory(directory, registry),
    requestLogDirectory: directory,
    ...(process.platform === 'win32'
      ? { bundles: await localMcpbAdapter(directory) }
      : {}),
    ...(process.platform === 'darwin' || process.platform === 'linux'
      ? {
          integrations: (() => {
            const platform = supportedPlatform(process.platform),
              targets = platformAgentTargets(
                platform,
                environment.HOME || homedir(),
                environment,
              );
            return {
              platform,
              targets,
              files: agentFiles(
                targets.flatMap((target) => target.paths),
                join(directory, 'agent-backups'),
              ),
              discovery: createPlatformDiscoveryPorts({
                workingDirectory: directory,
                environment,
              }),
              node: process.execPath,
              registry: join(directory, 'state.json'),
            };
          })(),
        }
      : {}),
    ...(process.platform === 'win32'
      ? {
          integrations: (() => {
            const targets = windowsAgentTargets(
              environment.USERPROFILE || homedir(),
              environment,
            );
            const paths = targets.flatMap((target) => target.paths);
            for (const path of paths)
              outsideProtectedPilot(
                path,
                'E:\\Dev\\Tools_and_Utilities\\mcp-hub',
              );
            return {
              targets,
              files: agentFiles(paths, join(directory, 'agent-backups')),
              discovery: createWindowsDiscoveryPorts({
                workingDirectory: directory,
                environment,
              }),
              node: process.execPath,
              registry: join(directory, 'state.json'),
            };
          })(),
        }
      : {}),
    secrets,
    materializer: createMaterializer({
      files,
      ...(command ? { docker: dockerProfiles(command, files) } : {}),
      nodeExecutable: process.execPath,
      launcherModuleUrl: new URL(
        '../../dist/runtime/launcher.js',
        import.meta.url,
      ).href,
      registryPath: join(directory, 'state.json'),
    }),
    runtime: createCapabilityRuntime({
      workingDirectory: directory,
      preparePackage: async (connector, signal, allowInstall = true) =>
        (await localPackageRuntime(directory)).prepare(
          connector,
          signal,
          allowInstall,
        ),
      prepareBundle: async (connector) =>
        (await localMcpbAdapter(directory)).prepare(connector),
      resolveBindings: createBindingResolver(secrets, registry),
      ...(command ? { docker: command } : {}),
    }),
  };
}
