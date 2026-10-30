import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyDesktopIntegrity } from './desktop-integrity.mjs';

const source = resolve(process.argv[2] ?? '');
if (!process.argv[2])
  throw new Error('Pass the generated portable folder path.');
await verifyDesktopIntegrity(source);
const directory = await mkdtemp(join(tmpdir(), 'hub-portable-check-'));
const app = join(directory, 'app'),
  data = join(directory, 'data');
let child;
try {
  await cp(source, app, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  await verifyDesktopIntegrity(app);
  const launcher = JSON.parse(
    await readFile(join(app, 'WaleedMcpHub.launcher.json'), 'utf8'),
  );
  const hash = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  assert.equal(launcher.protocol, 'wmh-launcher-v1');
  assert.equal(launcher.sha256, await hash(join(app, 'WaleedMcpHub.exe')));
  assert.equal(
    launcher.sourceSha256,
    await hash(join(app, 'scripts/WaleedMcpHub.cs')),
  );
  await cp(
    new URL('./verify-packaged-containment.mjs', import.meta.url),
    join(directory, 'containment.mjs'),
  );
  await cp(
    new URL('../tests/fixtures/process-child.mjs', import.meta.url),
    join(directory, 'process-child.mjs'),
  );
  const containment = await promisify(execFile)(
    join(app, 'runtime/node.exe'),
    [
      join(directory, 'containment.mjs'),
      app,
      join(directory, 'process-child.mjs'),
    ],
    {
      cwd: directory,
      env: { ...process.env, PATH: '', NODE_OPTIONS: '', NODE_PATH: '' },
      timeout: 60000,
      windowsHide: true,
    },
  );
  console.info(containment.stdout.trim());
  child = fork(join(app, 'apps/server/dist/main.js'), [], {
    cwd: app,
    execPath: join(app, 'runtime/node.exe'),
    execArgv: [],
    env: {
      ...process.env,
      PATH: '',
      NODE_OPTIONS: '',
      NODE_PATH: '',
      HUB_PORT: '4197',
      HUB_DATA_DIR: data,
      HUB_NO_OPEN: '1',
      HUB_DESKTOP: '1',
      HUB_DISCOVERY_MODE: 'disabled',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Never print launch URLs/tokens or raw process diagnostics.
  let diagnostic = '';
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', (chunk) => {
    if (diagnostic.length < 16000) diagnostic += chunk.toString();
  });
  const launch = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            'Packaged backend startup timed out. Native diagnostics were withheld.',
          ),
        ),
      45000,
    );
    child.once('message', (message) => {
      clearTimeout(timer);
      resolveReady(message.launchUrl);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      const dependency = diagnostic.match(
        /Cannot find (?:package|module) '([^']+)'/,
      );
      const missing = dependency?.[1]?.startsWith(app)
        ? dependency[1].slice(app.length)
        : dependency?.[1]?.match(/^[@a-zA-Z0-9_./-]+$/)?.[0];
      const code = diagnostic.match(
        /(?:code: |\[)'?((?:ERR_|MODULE_)[A-Z_]+)'?/,
      );
      reject(
        new Error(
          `Packaged backend exited before readiness${missing ? `: missing production artifact ${missing}` : ''}${code ? ` (${code[1]})` : ''}.`,
        ),
      );
    });
  });
  const url = new URL(launch);
  assert.equal(url.origin, 'http://127.0.0.1:4197');
  assert.equal((await fetch(`${url.origin}/api/bootstrap`)).status, 401);
  assert.equal(url.search, '');
  const token = new URLSearchParams(url.hash.slice(1)).get('launch');
  const response = await fetch(`${url.origin}/api/session`, {
    method: 'POST',
    headers: { origin: url.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const bootstrap = await fetch(`${url.origin}/api/bootstrap`, {
    headers: { cookie },
  });
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).capabilities.agentApply, true);
  const startup = await fetch(`${url.origin}/api/lifecycle/startup`, {
    headers: { cookie },
  });
  assert.equal(startup.status, 200);
  const startupStatus = await startup.json();
  assert.equal(startupStatus.available, true);
  assert(['disabled', 'conflict'].includes(startupStatus.state));
  const tray = await promisify(execFile)(
    join(app, 'WaleedMcpHub.exe'),
    ['--tray-self-test'],
    { timeout: 10000 },
  );
  assert.equal(
    tray.stdout.trim(),
    'wmh-tray-v1:Open Waleed MCP Hub|Check Health|Exit',
  );
  assert.equal((await fetch(url.origin)).status, 200);
  const exit = new Promise((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Packaged shutdown timed out.')),
      15000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error('Packaged shutdown was not successful.'));
      else resolveExit();
    });
  });
  child.send('shutdown');
  await exit;
  await assert.rejects(access(join(data, 'writer.lock')));
  console.info(
    'Portable inventory/hashes, launcher provenance, isolated startup, bundled JobObject containment, UI/session enforcement and graceful lock release passed. No agent/pilot or shortcut was changed.',
  );
} finally {
  if (child && child.exitCode === null) {
    const exit = new Promise((resolveExit) => child.once('exit', resolveExit));
    if (child.connected) child.send('shutdown', () => undefined);
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
  }
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}
