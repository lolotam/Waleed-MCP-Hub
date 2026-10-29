import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createLifecycle,
  openStateStore,
  openSafetyLedger,
  HubError,
  createWindowsDiscoveryPorts,
  createDiscoveryService,
  localRuntimeAdapters,
} from '@waleed/hub-core';
import { createHubServer } from './app.js';

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Use Node.js 24 LTS. See README.md.');
  const port = Number(process.env.HUB_PORT ?? 4177);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('HUB_PORT must be an integer from 1024 to 65535.');
  const directory =
    process.env.HUB_DATA_DIR ??
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
      'WaleedMcpHub',
    );
  const store = await openStateStore(directory);
  const safety = await openSafetyLedger(directory).catch(
    async (error: unknown) => {
      await store.close();
      throw error;
    },
  );
  // Recovery only classifies metadata against exact registry hashes; it never
  // executes an operation or rewrites registry/Docker/agent/secret state.
  try {
    await safety.reconcile(await store.read());
  } catch (error) {
    await safety.close();
    await store.close();
    throw error;
  }
  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  // Opt-in read-only scan: constructing this service does not read personal
  // configs or invoke Docker. Only the session/CSRF-protected discovery action does.
  const discoveryEnvironment = Object.fromEntries(
    [
      'PATH',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'PROGRAMDATA',
      'PROGRAMFILES',
      'PROGRAMW6432',
      'CODEX_HOME',
      'XDG_CONFIG_HOME',
      'OPENCODE_CONFIG',
      'CLAUDE_CONFIG_DIR',
      'KIMI_CODE_HOME',
      'DOCKER_CONFIG',
      'DOCKER_CONTEXT',
      'DOCKER_HOST',
    ].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]!]] : [],
    ),
  );
  const discovery =
    process.platform === 'win32' &&
    process.env.HUB_DISCOVERY_MODE !== 'disabled'
      ? createDiscoveryService(
          createWindowsDiscoveryPorts({
            workingDirectory: directory,
            environment: discoveryEnvironment,
          }),
          {
            home: homedir(),
            pilotDirectory:
              process.env.HUB_PILOT_DIR ??
              'E:\\Dev\\Tools_and_Utilities\\mcp-hub',
            profileId: 'waleed-mcp-hub-pilot',
            environment: discoveryEnvironment,
            nodeVersion: process.versions.node,
            platform: process.platform,
          },
        )
      : undefined;
  // Include adapter construction in startup cleanup: argument evaluation can
  // reject before createHubServer's promise exists (for example unsafe scopes).
  const hub = await (async () =>
    createHubServer({
      port,
      lifecycle: createLifecycle(
        store,
        Date.now,
        safety,
        await localRuntimeAdapters(directory, discoveryEnvironment, () =>
          store.read(),
        ),
      ),
      webRoot,
      ...(process.env.HUB_DESKTOP === '1'
        ? {
            shutdown: () => {
              void stop().then(() => process.disconnect?.());
            },
          }
        : {}),
      ...(discovery ? { discovery } : {}),
    }))().catch(async (error: unknown) => {
    await safety.close();
    await store.close();
    throw error;
  });
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      await hub.app.close();
    } finally {
      try {
        await safety.close();
      } finally {
        await store.close();
      }
    }
  }
  try {
    await hub.app.listen({ host: '127.0.0.1', port });
    const launchUrl = `${hub.origin}/#launch=${hub.issueLaunchToken()}`;
    console.info(
      `Waleed MCP Hub is listening at ${hub.origin}. No agent or Docker configuration has changed.`,
    );
    if (process.send) process.send({ launchUrl });
    if (process.env.HUB_NO_OPEN !== '1') {
      if (process.platform !== 'win32') {
        console.info(
          'Automatic browser launch is Windows-only. Use the test harness on other platforms.',
        );
      } else {
        // Fixed PowerShell program; URL is passed on stdin and never printed/logged.
        const opener = spawn(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$url = [Console]::In.ReadToEnd(); Start-Process -FilePath $url',
          ],
          {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'ignore'],
          },
        );
        opener.on('error', () =>
          console.error(
            'Browser launch failed. Restart from a Windows terminal to retry.',
          ),
        );
        opener.stdin.end(launchUrl);
      }
    }
    process.once('SIGINT', () => {
      void stop();
    });
    process.once('SIGTERM', () => {
      void stop();
    });
    process.on('message', (message) => {
      if (message === 'reopen' && !stopping)
        process.send?.({
          launchUrl: `${hub.origin}/#launch=${hub.issueLaunchToken()}`,
        });
      if (message === 'shutdown')
        void stop().then(() => process.disconnect?.());
    });
  } catch (error) {
    await stop();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      console.error(
        `Port ${port} is occupied. No process was stopped. Choose another HUB_PORT.`,
      );
    else
      console.error(
        'Hub startup failed. Check the build and local runtime directory.',
      );
    process.exitCode = 1;
    process.disconnect?.();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof HubError
      ? error.message
      : 'Hub startup failed. Use Node 24, build the workspace, and inspect the runtime lock/state without copying sensitive data into logs.',
  );
  process.exitCode = 1;
  process.disconnect?.();
});
