import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestQuit, startDesktop } from './desktop-runtime.mjs';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error('Desktop mode requires Node 24 on Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory =
  process.env.HUB_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? homedir(), 'WaleedMcpHub');
// The launcher is hidden, so stderr is invisible; keep a log the user can open.
mkdirSync(directory, { recursive: true });
const logFile = join(directory, 'desktop.log');
function log(message) {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* Logging must never stop the launcher. */
  }
}
process.on('uncaughtException', (error) => {
  log(`fatal: ${error?.message ?? error}`);
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
});
// The launcher starts this script with --attach, the tray starts it with
// --quit, and a user starts it without an argument to open the window.
function desktopMode(args) {
  if (args.length === 0) return 'open';
  if (args.length === 1 && args[0] === '--attach') return 'attach';
  if (args.length === 1 && args[0] === '--quit') return 'quit';
  return 'invalid';
}
// The launcher reads these exit codes to tell the tray what happened.
function quitExitCode(outcome) {
  if (outcome === 'quitting') return 0;
  if (outcome === 'absent') return 3;
  if (outcome === 'busy') return 4;
  if (outcome === 'unsupported') return 5;
  return 1;
}
const mode = desktopMode(process.argv.slice(2));
if (mode === 'invalid') {
  log('unknown desktop argument');
  process.stderr.write('Usage: desktop.mjs [--attach | --quit]\n');
  process.exit(2);
}
if (mode === 'quit') {
  const outcome = await requestQuit({ directory });
  log(`quit request answered with ${outcome}`);
  process.exit(quitExitCode(outcome));
}
const browserPaths = [
  process.env['PROGRAMFILES(X86)'],
  process.env.PROGRAMFILES,
  process.env.LOCALAPPDATA,
]
  .filter(Boolean)
  .map((base) => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
let browser;
// The browser is only needed when a window opens, so quitting and attaching
// to a running manager work on a machine without Edge.
async function findBrowser() {
  if (browser) return browser;
  for (const candidate of browserPaths) {
    try {
      await access(candidate);
      browser = candidate;
      return browser;
    } catch {
      /* Try the next fixed Edge installation path. */
    }
  }
  throw new Error('Microsoft Edge is required for Windows App Mode.');
}
await access(join(root, 'apps/server/dist/main.js'));
await access(join(root, 'apps/web/dist/index.html'));
if (mode === 'open') await findBrowser();
// A dedicated Edge profile isolates the app window from any already-running
// Edge instance on the default profile, which can swallow --app launches.
const edgeProfile = join(directory, 'edge-profile');
async function openEdgeWindow(url) {
  const executable = await findBrowser();
  const app = spawn(
    executable,
    [
      `--user-data-dir=${edgeProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--app=${url}`,
    ],
    { shell: false, stdio: 'ignore' },
  );
  // An open Edge window must not keep this manager alive after it closes.
  app.unref();
  log('opening Edge app window');
  app.on('error', (error) => {
    log(`Edge could not start: ${error.message}`);
    process.stderr.write('Windows App Mode could not open.\n');
  });
  app.on('exit', (code) => log(`Edge launch process exited with ${code}`));
}
const desktop = await startDesktop({
  root,
  directory,
  port: Number(process.env.HUB_PORT ?? 4177),
  attach: mode === 'attach',
  log,
  openWindow(url) {
    openEdgeWindow(url).catch((error) => {
      log(`Edge could not start: ${error?.message ?? error}`);
      process.stderr.write('Windows App Mode could not open.\n');
    });
  },
});
log(
  desktop.reused ? 'reused running desktop' : `started backend ${desktop.pid}`,
);
// The launcher reads this line to end when another launcher shows the tray.
if (desktop.reused && mode === 'attach')
  process.stdout.write('wmh-desktop-reused\n');
process.once('SIGINT', desktop.stop);
process.once('SIGTERM', desktop.stop);
await desktop.closed;
