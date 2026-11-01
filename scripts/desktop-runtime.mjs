import { createServer, createConnection } from 'node:net';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';

// The hub registers static routes at startup, so a rebuilt web app (new asset
// hashes) or server code is only served after the backend restarts.
async function buildFingerprint(root) {
  const hash = createHash('sha256');
  try {
    hash.update(await readFile(join(root, 'apps/web/dist/index.html')));
  } catch {
    /* Missing build: fingerprint stays comparable. */
  }
  for (const directory of [
    'apps/server/dist',
    'packages/hub-core/dist',
    'packages/contracts/dist',
  ]) {
    try {
      for (const entry of await readdir(join(root, directory), {
        recursive: true,
      })) {
        if (!entry.endsWith('.js')) continue;
        const info = await stat(join(root, directory, entry));
        hash.update(`${entry}:${info.mtimeMs}:${info.size}\n`);
      }
    } catch {
      /* Missing directory: fingerprint stays comparable. */
    }
  }
  return hash.digest('hex');
}

// Construction-only opener seam for disposable tests; never HTTP/environment input.
export async function startDesktop({
  root,
  directory,
  port = 4177,
  openWindow,
  log = () => {},
  environment = process.env,
  handoffDeadline = 0,
}) {
  const runtime = resolve(directory);
  const rootId = createHash('sha256')
    .update(resolve(root).toLowerCase())
    .digest('hex')
    .slice(0, 24);
  const pipe = `\\\\.\\pipe\\wmh-desktop-${createHash('sha256')
    .update(homedir().toLowerCase() + '|' + runtime.toLowerCase())
    .digest('hex')
    .slice(0, 32)}`;
  let backend,
    fingerprint,
    closing = false,
    restarting = false,
    ready = false,
    pending = false,
    handoffSocket;
  function reopen() {
    if (ready && backend?.connected) backend.send('reopen', () => undefined);
    else pending = true;
  }
  async function openOrRestart() {
    if (restarting || closing) return;
    if (!ready || (await buildFingerprint(root)) === fingerprint) {
      reopen();
      return;
    }
    // Graceful shutdown releases the locks; the exit handler forks the new build.
    log('build changed; restarting backend');
    restarting = true;
    ready = false;
    pending = false;
    if (backend.connected) backend.send('shutdown', () => undefined);
  }
  const control = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy());
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString();
      if (Buffer.byteLength(request) > 64) {
        socket.destroy();
        return;
      }
      if (request === 'open\n' || request === `open:${rootId}\n`) {
        void openOrRestart();
        socket.end('wmh-desktop-v1\n');
      } else if (/^open:[a-f0-9]{24}\n$/.test(request)) {
        // A new version lives in a different installation folder. Release the
        // old backend and its locks before the replacement claims this pipe.
        if (!backend?.connected || closing) {
          socket.destroy();
          return;
        }
        socket.setTimeout(15000, () => socket.destroy());
        handoffSocket = socket;
        log('different installation requested a desktop handoff');
        closing = true;
        backend.send('shutdown', () => undefined);
      } else if (request.includes('\n')) socket.destroy();
    });
  });
  const error = await new Promise((resolveListen) => {
    control.once('error', resolveListen);
    control.listen({ path: pipe, readableAll: false, writableAll: false }, () =>
      resolveListen(null),
    );
  });
  if (error) {
    if (error.code !== 'EADDRINUSE')
      throw new Error('Desktop control unavailable. No lock was removed.');
    // The old Windows pipe can remain reserved briefly after its shutdown
    // reply. Only an acknowledged handoff permits this bounded bind retry.
    if (Date.now() < handoffDeadline) {
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 25));
      return startDesktop({
        root,
        directory,
        port,
        openWindow,
        log,
        environment,
        handoffDeadline,
      });
    }
    const requestOwner = (request) =>
      new Promise((resolveClient, reject) => {
        const client = createConnection(pipe, () => client.write(request));
        let reply = '';
        let acknowledged = false,
          replace = false;
        client.setTimeout(15000, () => {
          client.destroy();
          reject(new Error('Desktop control timed out.'));
        });
        client.on('data', (data) => {
          reply += data.toString();
          if (
            reply === 'wmh-desktop-v1\n' ||
            reply === 'wmh-desktop-handoff\n'
          ) {
            acknowledged = true;
            replace = reply === 'wmh-desktop-handoff\n';
            client.destroy();
          } else if (reply.length > 64 || reply.includes('\n')) {
            client.destroy();
            reject(new Error('Unknown desktop control owner.'));
          }
        });
        client.once('error', (error) =>
          reject(
            new Error('Existing desktop unavailable; no process was stopped.', {
              cause: error,
            }),
          ),
        );
        client.once('close', () => {
          if (acknowledged) resolveClient(replace);
          else
            reject(
              Object.assign(
                new Error(
                  'Stop the existing desktop manager in Settings, then open this installation again. No process was stopped.',
                ),
                { legacyClose: true },
              ),
            );
        });
      });
    let handedOff;
    try {
      handedOff = await requestOwner(`open:${rootId}\n`);
    } catch (error) {
      // Legacy managers understand only open\n and close the connection
      // without a reply. A timeout or an unknown owner is not that: a manager
      // that is still shutting down would acknowledge open\n and leave no
      // desktop behind.
      if (!error?.legacyClose) throw error;
      // Reopen that verified protocol without killing it or deleting its
      // locks; Settings can stop it safely.
      handedOff = await requestOwner('open\n');
      log(
        'legacy desktop reopened; stop its manager in Settings to activate this installation',
      );
    }
    if (handedOff) {
      log('previous desktop backend stopped; claiming its control pipe');
      return startDesktop({
        root,
        directory,
        port,
        openWindow,
        log,
        environment,
        handoffDeadline: Date.now() + 3000,
      });
    }
    return { reused: true, closed: Promise.resolve(), stop() {} };
  }
  let resolveExit;
  const closed = new Promise((resolve) => {
    resolveExit = resolve;
  });
  async function launch() {
    for (const lockName of ['writer.lock', 'safety.lock']) {
      try {
        const lockFile = join(runtime, lockName);
        const content = JSON.parse(await readFile(lockFile, 'utf8'));
        if (typeof content.pid === 'number') {
          let alive = false;
          try {
            process.kill(content.pid, 0);
            alive = true;
          } catch (e) {
            alive = e.code !== 'ESRCH';
          }
          if (!alive) {
            await unlink(lockFile).catch(() => undefined);
          }
        }
      } catch {
        /* File does not exist or cannot be parsed; safe to proceed. */
      }
    }
    fingerprint = await buildFingerprint(root);
    backend = fork(join(root, 'apps/server/dist/main.js'), [], {
      execArgv: [],
      env: {
        ...environment,
        HUB_DATA_DIR: runtime,
        HUB_PORT: String(port),
        HUB_NO_OPEN: '1',
        HUB_DESKTOP: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    backend.stdout.on('data', () => undefined);
    backend.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      log(`backend stderr: ${text.trim()}`);
      process.stderr.write(`Desktop backend: ${text}`);
    });
    backend.on('message', (message) => {
      if (!message || typeof message.launchUrl !== 'string') return;
      try {
        const url = new URL(message.launchUrl);
        if (
          url.origin !== `http://127.0.0.1:${port}` ||
          url.pathname !== '/' ||
          url.search ||
          !/^#launch=[a-f0-9]{64}$/.test(url.hash)
        )
          return;
        ready = true;
        openWindow(url.href);
        if (pending) {
          pending = false;
          reopen();
        }
      } catch {
        process.stderr.write('Desktop window launch failed.\n');
      }
    });
    backend.once('exit', (code) => {
      if (restarting && !closing && !code) {
        restarting = false;
        void launch().catch((error) => {
          log(`restart failed: ${error?.message ?? error}`);
          process.exitCode = 1;
          control.close(() => resolveExit());
        });
        return;
      }
      if (handoffSocket) {
        // Keep the Windows pipe listener alive until its reply has flushed.
        // Closing it earlier can reset the handoff connection on Windows.
        handoffSocket.end('wmh-desktop-handoff\n', () =>
          control.close(() => resolveExit()),
        );
      } else control.close(() => resolveExit());
      if (code) process.exitCode = code;
    });
    backend.once('error', () => {
      control.close(() => resolveExit());
      process.exitCode = 1;
    });
  }
  await launch();
  function stop() {
    if (closing) return;
    closing = true;
    control.close();
    if (backend.connected) backend.send('shutdown', () => undefined);
  }
  return {
    reused: false,
    get pid() {
      return backend.pid;
    },
    closed,
    stop,
  };
}
