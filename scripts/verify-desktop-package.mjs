import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, access } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? '');
if (!process.argv[2])
  throw new Error('Pass the generated portable folder path.');
const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\hub-portable-check-');
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
  child = fork(join(app, 'apps/server/dist/main.js'), [], {
    execPath: join(app, 'runtime/node.exe'),
    execArgv: [],
    env: {
      ...process.env,
      PATH: '',
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
            `Packaged backend startup timed out. Diagnostic: ${diagnostic}`,
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
  assert.equal((await fetch(url.origin)).status, 200);
  const exit = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.send('shutdown');
  await exit;
  await assert.rejects(access(join(data, 'writer.lock')));
  console.info(
    'Portable folder starts outside the workspace with its bundled Node/runtime dependencies, serves the UI, enforces sessions and releases locks on shutdown. No agent/pilot or shortcut was changed.',
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
