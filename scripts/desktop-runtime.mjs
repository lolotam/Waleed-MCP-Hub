import { createServer, createConnection } from 'node:net';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';

// At most eight trays can watch one manager; a ninth one is told to wait.
const MAX_ATTACHMENTS = 8;
// The pipe name is derived from the data directory, so every installation of
// one user shares one control pipe and the root id tells them apart.
function controlPipe(directory) {
  return `\\\\.\\pipe\\wmh-desktop-${createHash('sha256')
    .update(homedir().toLowerCase() + '|' + resolve(directory).toLowerCase())
    .digest('hex')
    .slice(0, 32)}`;
}

// A tray attaches to the manager that owns the pipe and stays attached until
// that manager goes away. A manager that does not know the request closes
// the connection, which releases the tray immediately.
function attachToPipe(pipe, log) {
  return new Promise((resolveClosed) => {
    const client = createConnection(pipe);
    let reply = '';
    let attached = false;
    const handshake = setTimeout(() => client.destroy(), 5000);
    client.on('connect', () => client.write('attach\n'));
    client.on('data', (chunk) => {
      reply += chunk.toString();
      if (reply.includes('wmh-desktop-attached')) {
        attached = true;
        clearTimeout(handshake);
      } else if (reply.includes('wmh-desktop-busy'))
        log('the desktop manager is busy; the tray cannot attach');
    });
    // The close handler below reports the lost attachment; the error itself
    // carries no extra information for the tray.
    client.on('error', () => undefined);
    client.on('close', () => {
      clearTimeout(handshake);
      if (!attached)
        log(
          'the desktop manager closed the attach request; the tray cannot attach',
        );
      resolveClosed();
    });
  });
}

// Asks the manager that owns the pipe to quit and reports what it answered.
export async function requestQuit({ directory }) {
  const pipe = controlPipe(directory);
  return new Promise((resolveOutcome) => {
    const client = createConnection(pipe);
    let reply = '';
    let settled = false;
    let deadline;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      client.destroy();
      resolveOutcome(outcome);
    };
    deadline = setTimeout(() => finish('failed'), 5000);
    client.on('connect', () => client.write('quit\n'));
    client.on('data', (chunk) => {
      reply += chunk.toString();
      if (reply === 'wmh-desktop-quitting\n') finish('quitting');
      else if (reply === 'wmh-desktop-busy\n') finish('busy');
      else if (reply.length > 64) finish('failed');
    });
    client.on('error', (error) =>
      finish(error?.code === 'ENOENT' ? 'absent' : 'failed'),
    );
    client.on('close', () => finish(reply ? 'failed' : 'unsupported'));
  });
}

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
  attach = false,
}) {
  const runtime = resolve(directory);
  const rootId = createHash('sha256')
    .update(resolve(root).toLowerCase())
    .digest('hex')
    .slice(0, 24);
  const pipe = controlPipe(runtime);
  let backend,
    fingerprint,
    closing = false,
    restarting = false,
    ready = false,
    pending = false,
    handoffSocket;
  const attachments = new Set();
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
    socket.on('close', () => attachments.delete(socket));
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString();
      if (Buffer.byteLength(request) > 64) {
        socket.destroy();
        return;
      }
      handleControlRequest(request, socket);
    });
  });
  function handleControlRequest(request, socket) {
    if (request === 'open\n' || request === `open:${rootId}\n`) {
      handleOpen(socket);
      return;
    }
    if (request === 'attach\n') {
      attachTray(socket);
      return;
    }
    if (request === 'quit\n') {
      quitManager(socket);
      return;
    }
    if (/^open:[a-f0-9]{24}\n$/.test(request)) {
      handOver(socket);
      return;
    }
    if (request.includes('\n')) socket.destroy();
  }
  function handleOpen(socket) {
    // A closing manager opens nothing, so it must not acknowledge.
    if (closing) {
      socket.end('wmh-desktop-busy\n');
      return;
    }
    void openOrRestart();
    socket.end('wmh-desktop-v1\n');
  }
  function handOver(socket) {
    // A new version lives in a different installation folder. Release the
    // old backend and its locks before the replacement claims this pipe.
    // A refusal is answered, never a bare close: only a manager that does
    // not know the request closes in silence, and the caller reads that as
    // a legacy manager.
    if (!backend?.connected || closing) {
      socket.end('wmh-desktop-busy\n');
      return;
    }
    socket.setTimeout(15000, () => socket.destroy());
    handoffSocket = socket;
    log('different installation requested a desktop handoff');
    closing = true;
    backend.send('shutdown', () => undefined);
  }
  function attachTray(socket) {
    if (closing || attachments.size >= MAX_ATTACHMENTS) {
      socket.end('wmh-desktop-busy\n');
      return;
    }
    // The tray stays attached for as long as the backend runs, so its idle
    // timeout is switched off.
    socket.setTimeout(0);
    attachments.add(socket);
    socket.write('wmh-desktop-attached\n');
  }
  function quitManager(socket) {
    if (closing) {
      socket.end('wmh-desktop-busy\n');
      return;
    }
    socket.end('wmh-desktop-quitting\n', () => stop());
  }
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
        attach,
      });
    }
    const requestOwner = (request) =>
      new Promise((resolveClient, reject) => {
        const client = createConnection(pipe, () => client.write(request));
        let reply = '';
        let acknowledged = false,
          busy = false,
          replace = false;
        client.setTimeout(15000, () => {
          client.destroy();
          reject(new Error('Desktop control timed out.'));
        });
        client.on('data', (data) => {
          reply += data.toString();
          if (reply === 'wmh-desktop-busy\n') {
            busy = true;
            client.destroy();
          } else if (
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
          else if (busy)
            reject(
              new Error(
                'The existing desktop manager is closing or starting. Open this installation again in a moment. No process was stopped.',
              ),
            );
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
      // without a reply. A timeout, an unknown owner or a busy manager is not
      // that: a manager that is still shutting down would acknowledge open\n
      // and leave no desktop behind. A build older than the busy reply also
      // closes in silence and cannot be told apart from a legacy manager.
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
        attach,
      });
    }
    if (attach) {
      // The tray watches the running manager until that manager goes away.
      return { reused: true, closed: attachToPipe(pipe, log), stop() {} };
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
    // A quit that arrived while a restart awaited has nothing to stop.
    if (closing) {
      finalize();
      return;
    }
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
          finalize();
        });
        return;
      }
      if (handoffSocket) {
        // Keep the Windows pipe listener alive until its reply has flushed.
        // Closing it earlier can reset the handoff connection on Windows.
        handoffSocket.end('wmh-desktop-handoff\n', () => finalize());
      } else finalize();
      if (code) process.exitCode = code;
    });
    backend.once('error', () => {
      finalize();
      process.exitCode = 1;
    });
  }
  await launch();
  function finalize() {
    // net.Server.close waits for open connections, so the attached sockets are
    // destroyed immediately before it.
    for (const socket of attachments) socket.destroy();
    attachments.clear();
    control.close(() => resolveExit());
  }
  function stop() {
    if (closing) return;
    closing = true;
    // The listener and the attached sockets stay open until the backend exits,
    // so a tray stays attached exactly as long as the backend runs.
    if (backend?.connected) backend.send('shutdown', () => undefined);
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
