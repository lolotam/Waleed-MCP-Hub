import { win32, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import type { Connector } from '@waleed/contracts';
import { createWindowsProcessRunner } from '../native/process-runner.js';
import type { DockerCommand } from '../docker-profile.js';
import { assertNoLinks } from '../managed-files.js';
import {
  RuntimeFault,
  enumerateCapabilities,
  type CapabilityRuntime,
} from '../../runtime/capabilities.js';
import { safeMcpHttpTransport } from './http.js';
import { ContainedStdioTransport } from './stdio.js';
import { cleanupOwnedContainers } from './container-cleanup.js';
import type { SecretLease } from '../../auth/bindings.js';
import { packagesRoot } from '../../packages/store.js';
import { verifyPackage } from '../../packages/verify.js';

export function isolatedNativeArguments(
  connector: Extract<Connector, { executionMode: 'native' }>,
) {
  if (
    connector.arguments.some((argument) =>
      /^--(?:browser-url|browserURL|autoConnect|auto-connect|user-data-dir|userDataDir)(?:=|$)/i.test(
        argument,
      ),
    )
  )
    throw new RuntimeFault('adapter_pending');
  const chrome = [connector.executable, ...connector.arguments].some(
    (argument) => /chrome-devtools-mcp/i.test(argument),
  );
  return chrome && !connector.arguments.includes('--isolated')
    ? [...connector.arguments, '--isolated']
    : [...connector.arguments];
}
export function createCapabilityRuntime(options: {
  workingDirectory: string;
  docker?: DockerCommand;
  fixtureOrigin?: string;
  resolveBindings?: (
    connector: Connector,
    signal: AbortSignal,
  ) => Promise<SecretLease>;
}): CapabilityRuntime {
  return {
    async discover(connector, signal) {
      // A managed install is verified first: when the folder is not the
      // approved one, no secret is resolved and no process is started.
      if (connector.executionMode === 'native' && connector.package)
        await verifyPackage(connector, packagesRoot(options.workingDirectory));
      const bound =
        Object.keys(connector.secretBindings).length ||
        Object.keys(connector.headerBindings).length;
      if (bound && connector.executionMode === 'docker')
        throw new RuntimeFault('adapter_pending');
      if (bound && !options.resolveBindings)
        throw new RuntimeFault('secrets_pending');
      const lease = bound
        ? await options.resolveBindings!(connector, signal)
        : undefined;
      const clean = (
        result: Awaited<ReturnType<typeof enumerateCapabilities>>,
      ) => {
        const publicData = JSON.stringify(result);
        for (const value of [
          ...Object.values(lease?.environment ?? {}),
          ...Object.values(lease?.headers ?? {}),
        ]) {
          let decoded = '';
          if (/^Basic\s+/i.test(value)) {
            const bytes = Buffer.from(
              value.replace(/^Basic\s+/i, ''),
              'base64',
            );
            try {
              decoded = bytes.toString('utf8');
            } finally {
              bytes.fill(0);
            }
          }
          for (const secret of [
            value,
            value.replace(/^(?:Bearer|Basic)\s+/i, ''),
            decoded,
          ]) {
            if (
              [
                secret,
                encodeURIComponent(secret),
                Buffer.from(secret).toString('base64'),
              ].some((variant) => variant && publicData.includes(variant))
            )
              throw new RuntimeFault('protocol_error');
          }
        }
        return result;
      };
      try {
        if (connector.executionMode === 'remote')
          return clean(
            await enumerateCapabilities(
              safeMcpHttpTransport(
                connector.endpoint,
                connector.transport,
                signal,
                options.fixtureOrigin,
                lease?.headers,
              ),
              signal,
            ),
          );
        if (connector.executionMode === 'native') {
          if (
            !/^[a-z]:[\\/]/i.test(connector.executable) ||
            win32.extname(connector.executable).toLowerCase() !== '.exe'
          )
            throw new RuntimeFault('adapter_pending');
          await assertNoLinks(connector.executable);
          const runner = await createWindowsProcessRunner({
            allowedExecutables: [connector.executable],
            workingDirectory: options.workingDirectory,
            concurrency: 1,
          });
          return clean(
            await enumerateCapabilities(
              new ContainedStdioTransport(
                runner,
                {
                  executable: connector.executable,
                  arguments: isolatedNativeArguments(connector),
                  environment: {
                    ...(connector.environmentLiterals ?? {}),
                    ...lease?.environment,
                  },
                  timeoutMs: 25_000,
                  outputLimitBytes: 1024 * 1024,
                },
                signal,
              ),
              signal,
            ),
          );
        }
        const docker = options.docker;
        if (!docker) throw new RuntimeFault('dependency_unavailable');
        const nonce = randomUUID();
        const auditDirectory = join(options.workingDirectory, 'owned-checks');
        await assertNoLinks(auditDirectory, true);
        await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
        await assertNoLinks(auditDirectory);
        const ownershipFile = join(auditDirectory, `wmh-${nonce}.json`);
        const file = await open(ownershipFile, 'wx', 0o600);
        try {
          await file.writeFile(
            JSON.stringify({
              connectorId: connector.id,
              nonce,
              createdAt: new Date().toISOString(),
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        const label = `wmh.client=${nonce}`;
        let attempted = false;
        let result:
          Awaited<ReturnType<typeof enumerateCapabilities>> | undefined;
        let failure: unknown;
        try {
          // Probe context/version through the fixed Docker adapter before running an
          // approved image. No provider/API environment is inherited by the container.
          await docker.run(
            ['version', '--format', '{{.Server.Version}}'],
            signal,
          );
          const runner = await createWindowsProcessRunner({
            allowedExecutables: [docker.executable],
            workingDirectory: options.workingDirectory,
            concurrency: 1,
          });
          const args = [
            'run',
            '--rm',
            '--interactive',
            '--label',
            label,
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
          ];
          attempted = true;
          result = await enumerateCapabilities(
            new ContainedStdioTransport(
              runner,
              {
                executable: docker.executable,
                arguments: args,
                environment: { ...docker.environment },
                timeoutMs: 25_000,
                outputLimitBytes: 1024 * 1024,
              },
              signal,
            ),
            signal,
          );
        } catch (error) {
          failure = error;
        }
        {
          if (attempted)
            await cleanupOwnedContainers(docker, nonce, connector.id);
          await unlink(ownershipFile);
        }
        if (failure) throw failure;
        if (!result) throw new RuntimeFault('protocol_error');
        return result;
      } finally {
        lease?.dispose();
      }
    },
  };
}
