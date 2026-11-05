// The tray icon needs a control protocol: attach to a running manager, and
// ask a running manager to quit. These tests drive a real named pipe in a
// temp directory, like the existing desktop tests.
import { createConnection, createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The desktop runtime is a plain ES module without types.
import { requestQuit, startDesktop } from '../scripts/desktop-runtime.mjs';

type Manager = {
  reused: boolean;
  pid?: number;
  closed: Promise<void>;
  stop(): void;
};

// A backend that answers the launch handshake and then waits for a shutdown.
const liveBackend = `
import { randomBytes } from 'node:crypto';
process.on('message', (message) => {
  if (message === 'shutdown') process.disconnect();
});
process.send({
  launchUrl:
    'http://127.0.0.1:' + process.env.HUB_PORT + '/#launch=' + randomBytes(32).toString('hex'),
});
`;

// A backend that never shuts down, so the manager stays in its closing state.
const stalledBackend = `
import { randomBytes } from 'node:crypto';
process.on('message', () => {});
process.send({
  launchUrl:
    'http://127.0.0.1:' + process.env.HUB_PORT + '/#launch=' + randomBytes(32).toString('hex'),
});
`;

const pipeFor = (directory: string) =>
  `\\\\.\\pipe\\wmh-desktop-${createHash('sha256')
    .update(`${homedir().toLowerCase()}|${resolve(directory).toLowerCase()}`)
    .digest('hex')
    .slice(0, 32)}`;

describe.skipIf(process.platform !== 'win32')('desktop control pipe', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  const temporaryDirectory = async (name: string) => {
    const directory = await mkdtemp(join(tmpdir(), `hub-control-${name}-`));
    cleanup.push(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    return directory;
  };

  // A pipe owner that answers like a manager of an older hub version.
  async function fakeOwner(
    directory: string,
    answer: (socket: Socket) => void,
  ) {
    const sockets: Socket[] = [];
    const owner = createServer((socket) => {
      socket.on('error', () => socket.destroy());
      sockets.push(socket);
      answer(socket);
    });
    await new Promise<void>((done) => owner.listen(pipeFor(directory), done));
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => owner.close(done));
    });
  }

  async function manager(backend = liveBackend) {
    const root = await mkdtemp(join(tmpdir(), 'hub-control-root-'));
    const directory = await temporaryDirectory('data');
    await mkdir(join(root, 'apps/server/dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'apps/server/dist/main.js'), backend);
    const host = (await startDesktop({
      root,
      directory,
      port: 4202,
      openWindow: () => undefined,
    })) as Manager;
    cleanup.push(async () => {
      host.stop();
      const finished = await Promise.race([
        host.closed.then(() => true),
        new Promise<boolean>((settle) => setTimeout(() => settle(false), 3000)),
      ]);
      if (!finished && host.pid) {
        try {
          process.kill(host.pid);
        } catch {
          /* The backend already ended. */
        }
        await Promise.race([
          host.closed,
          new Promise((settle) => setTimeout(settle, 3000)),
        ]);
      }
      await rm(root, { recursive: true, force: true });
    });
    return { host, directory };
  }

  function connect(directory: string, request: string) {
    const client = createConnection(pipeFor(directory), () =>
      client.write(request),
    );
    let text = '';
    let settleReply: (value: string) => void = () => undefined;
    const reply = new Promise<string>((settle) => {
      settleReply = settle;
    });
    const closed = new Promise<void>((settle) => {
      client.once('close', () => settle());
    });
    client.setTimeout(5000, () => client.destroy());
    client.on('data', (chunk) => {
      text += chunk.toString();
      settleReply(text);
    });
    client.on('error', () => undefined);
    client.on('close', () => settleReply(text));
    return { client, reply, closed };
  }

  it('keeps an attachment open until the manager stops', async () => {
    const { host, directory } = await manager();
    const attached = connect(directory, 'attach\n');

    await expect(attached.reply).resolves.toBe('wmh-desktop-attached\n');
    await expect(
      Promise.race([
        attached.closed.then(() => 'closed'),
        new Promise((settle) => setTimeout(() => settle('open'), 300)),
      ]),
    ).resolves.toBe('open');

    host.stop();
    await host.closed;
    await expect(attached.closed).resolves.toBeUndefined();
  });

  it('closes the control pipe even while a tray stays attached', async () => {
    const { host, directory } = await manager();
    const attached = connect(directory, 'attach\n');
    await attached.reply;

    host.stop();
    await expect(
      Promise.race([
        host.closed.then(() => 'closed'),
        new Promise((settle) => setTimeout(() => settle('timeout'), 5000)),
      ]),
    ).resolves.toBe('closed');
    attached.client.destroy();
  });

  it('keeps the attachment open while a stalled backend is shutting down', async () => {
    const { host, directory } = await manager(stalledBackend);
    const attached = connect(directory, 'attach\n');
    await attached.reply;

    host.stop();
    let closed = false;
    attached.client.on('close', () => {
      closed = true;
    });
    await new Promise((settle) => setTimeout(settle, 500));
    expect(closed).toBe(false);

    attached.client.destroy();
  });

  it('quits the manager and acknowledges the request', async () => {
    const { host, directory } = await manager();
    const quitting = connect(directory, 'quit\n');

    await expect(quitting.reply).resolves.toBe('wmh-desktop-quitting\n');
    await host.closed;
  });

  it('answers attach and quit with busy while the manager is closing', async () => {
    const { host, directory } = await manager(stalledBackend);
    host.stop();

    const attaching = connect(directory, 'attach\n');
    await expect(attaching.reply).resolves.toBe('wmh-desktop-busy\n');
    const quitting = connect(directory, 'quit\n');
    await expect(quitting.reply).resolves.toBe('wmh-desktop-busy\n');
  });

  it('refuses the ninth attachment', async () => {
    const { directory } = await manager();
    const attached = Array.from({ length: 8 }, () =>
      connect(directory, 'attach\n'),
    );
    for (const socket of attached) {
      await expect(socket.reply).resolves.toBe('wmh-desktop-attached\n');
    }

    const ninth = connect(directory, 'attach\n');
    await expect(ninth.reply).resolves.toBe('wmh-desktop-busy\n');
    for (const socket of attached) socket.client.destroy();
  });

  it('reports an absent manager when no pipe exists', async () => {
    const directory = await temporaryDirectory('absent');

    await expect(requestQuit({ directory })).resolves.toBe('absent');
  });

  it('reports an unsupported manager when the pipe closes without a reply', async () => {
    const directory = await temporaryDirectory('legacy');
    await fakeOwner(directory, (socket) => socket.destroy());

    await expect(requestQuit({ directory })).resolves.toBe('unsupported');
  });

  it('reports a failure when the manager answers with an unknown reply', async () => {
    const directory = await temporaryDirectory('unknown');
    await fakeOwner(directory, (socket) => socket.end('not-a-desktop\n'));

    await expect(requestQuit({ directory })).resolves.toBe('failed');
  });

  it('reports a failure when the manager never answers', async () => {
    const directory = await temporaryDirectory('silent');
    await fakeOwner(directory, () => undefined);

    await expect(requestQuit({ directory })).resolves.toBe('failed');
  }, 15000);

  it('keeps a desktop.mjs --attach child alive while the manager runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-control-attach-'));
    const directory = await temporaryDirectory('attach-data');
    // The attach child derives its installation root from its own location,
    // so it runs from the same root as the manager under test.
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'apps/server/dist'), { recursive: true });
    await mkdir(join(root, 'apps/web/dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'apps/server/dist/main.js'), liveBackend);
    await writeFile(join(root, 'apps/web/dist/index.html'), '<!doctype html>');
    const repository = fileURLToPath(new URL('../', import.meta.url));
    await copyFile(
      join(repository, 'scripts', 'desktop.mjs'),
      join(root, 'scripts', 'desktop.mjs'),
    );
    await copyFile(
      join(repository, 'scripts', 'desktop-runtime.mjs'),
      join(root, 'scripts', 'desktop-runtime.mjs'),
    );

    // The opener stands in for the Edge window: it stays alive while the
    // manager stops and must not keep anything else alive.
    const opener = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { stdio: 'ignore' },
    );
    const host = (await startDesktop({
      root,
      directory,
      port: 4203,
      openWindow: () => undefined,
    })) as Manager;
    const child = spawn(
      process.execPath,
      [join(root, 'scripts', 'desktop.mjs'), '--attach'],
      {
        env: { ...process.env, HUB_DATA_DIR: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.resume();
    child.stderr?.resume();
    cleanup.push(async () => {
      if (child.exitCode === null) child.kill();
      opener.kill();
      host.stop();
      await Promise.race([
        host.closed,
        new Promise((settle) => setTimeout(settle, 3000)),
      ]);
      await rm(root, { recursive: true, force: true });
    });

    await new Promise((settle) => setTimeout(settle, 1500));
    expect(child.exitCode).toBeNull();

    host.stop();
    await host.closed;
    await expect(
      Promise.race([
        new Promise((settle) => child.once('exit', (code) => settle(code))),
        new Promise((settle) => setTimeout(() => settle('timeout'), 8000)),
      ]),
    ).resolves.toBe(0);
    expect(opener.exitCode).toBeNull();
  }, 30000);
});
