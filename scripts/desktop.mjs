import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktop } from './desktop-runtime.mjs';
import { createInterface } from 'node:readline';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error('Desktop mode requires Node 24 on Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const paths = [
  process.env['PROGRAMFILES(X86)'],
  process.env.PROGRAMFILES,
  process.env.LOCALAPPDATA,
]
  .filter(Boolean)
  .map((base) => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
let browser;
for (const path of paths) {
  try {
    await access(path);
    browser = path;
    break;
  } catch {
    /* Try the next fixed Edge installation path. */
  }
}
if (!browser)
  throw new Error('Microsoft Edge is required for Windows App Mode.');
await access(join(root, 'apps/server/dist/main.js'));
await access(join(root, 'apps/web/dist/index.html'));
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
// A dedicated Edge profile isolates the app window from any already-running
// Edge instance on the default profile, which can swallow --app launches.
const edgeProfile = join(directory, 'edge-profile');
const desktop = await startDesktop({
  root,
  directory,
  port: Number(process.env.HUB_PORT ?? 4177),
  log,
  background: process.argv.includes('--background'),
  preferencesChanged(value) {
    process.stdout.write(
      `wmh-keep-tray:${value.keepRunningInTray ? '1' : '0'}\n`,
    );
  },
  openWindow(url) {
    const app = spawn(
      browser,
      [
        `--user-data-dir=${edgeProfile}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--app=${url}`,
      ],
      { shell: false, stdio: 'ignore' },
    );
    log('opening Edge app window');
    app.unref(); // Tray Exit must not wait for the separately owned Edge window.
    if (app.pid) process.stdout.write(`wmh-edge-pid:${app.pid}\n`);
    app.on('error', (error) => {
      log(`Edge could not start: ${error.message}`);
      process.stderr.write('Windows App Mode could not open.\n');
    });
    app.on('exit', (code) => log(`Edge launch process exited with ${code}`));
  },
});
log(
  desktop.reused ? 'reused running desktop' : `started backend ${desktop.pid}`,
);
if (!desktop.reused) {
  process.stdout.write('wmh-desktop-owner-v1\n');
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    if (line.length > 16) {
      input.close();
      return;
    }
    if (line === 'open') void desktop.open().catch(() => undefined);
    if (line === 'health') desktop.checkHealth();
    if (line === 'exit') desktop.stop();
  });
  desktop.closed.then(() => input.close());
}
process.once('SIGINT', desktop.stop);
process.once('SIGTERM', desktop.stop);
await desktop.closed;
