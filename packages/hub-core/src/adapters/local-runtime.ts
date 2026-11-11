import { join } from 'node:path';
import { homedir } from 'node:os';
import { createWindowsDiscoveryPorts } from './discovery-files.js';
import { createWindowsProcessRunner } from './native/process-runner.js';
import { managedFiles, readOwnedFile } from './managed-files.js';
import {
  dockerCommand,
  dockerProfiles,
  type DockerCommand,
} from './docker-profile.js';
import { createMaterializer } from '../runtime/materialize.js';
import { createCapabilityRuntime } from './mcp/runtime.js';
import type { LifecycleAdapters } from '../lifecycle.js';
import { StateSchema, type HubState } from '@waleed/contracts';
import { windowsSecretStore } from './secrets/windows.js';
import { dockerSecretStore } from './secrets/docker.js';
import { createBindingResolver } from '../auth/bindings.js';
import type { SecretBackends } from '../auth/secrets.js';
import { windowsAgentTargets } from '../integrations/targets.js';
import { agentFiles, outsideProtectedPilot } from '../integrations/files.js';
import { packagesRoot } from '../packages/store.js';

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
  const secrets: SecretBackends = {};
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
    // Initialize protection on an explicit credential/auth action, not dashboard
    // startup. Preflight proves availability before writes/provider authorization.
    let windows: ReturnType<typeof windowsSecretStore> | undefined;
    const protectedStore = () =>
      (windows ??= windowsSecretStore(join(directory, 'credentials')).catch(
        (error: unknown) => {
          windows = undefined;
          throw error;
        },
      ));
    secrets.windows = {
      async has(id, signal) {
        return (await protectedStore()).has(id, signal);
      },
      async put(id, value, signal) {
        return (await protectedStore()).put(id, value, signal);
      },
      async read(id, signal) {
        return (await protectedStore()).read!(id, signal);
      },
      async delete(id, signal) {
        return (await protectedStore()).delete(id, signal);
      },
    };
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
      // Checked and read through one handle; over 16 MiB is refused.
      const bytes = await readOwnedFile(path, 16 * 1024 * 1024);
      if (bytes === null) throw new Error('Registry is missing.');
      return StateSchema.parse(JSON.parse(bytes.toString('utf8')));
    });
  return {
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
    packages: {
      packagesDir: packagesRoot(directory),
      nodeExecutable: process.execPath,
    },
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
      resolveBindings: createBindingResolver(secrets, registry),
      ...(command ? { docker: command } : {}),
    }),
  };
}
