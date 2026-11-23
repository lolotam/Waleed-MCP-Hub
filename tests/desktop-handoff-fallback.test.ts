// A manager that is still shutting down must not be reopened through the
// legacy protocol: it would acknowledge `open` and leave no desktop behind.
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The desktop runtime is a plain ES module without types.
import { edgeAppArguments, startDesktop } from '../scripts/desktop-runtime.mjs';

describe.skipIf(process.platform !== 'win32')(
  'desktop handoff to an existing manager',
  () => {
    const cleanup: Array<() => Promise<void>> = [];
    afterEach(async () => {
      await Promise.all(cleanup.splice(0).map((close) => close()));
    });
    // The pipe is derived from the data directory, as the manager does.
    async function existingOwner(
      reply: (request: string, socket: import('node:net').Socket) => void,
    ) {
      const directory = await mkdtemp(join(tmpdir(), 'hub-handoff-'));
      const pipe = `\\\\.\\pipe\\wmh-desktop-${createHash('sha256')
        .update(
          `${homedir().toLowerCase()}|${resolve(directory).toLowerCase()}`,
        )
        .digest('hex')
        .slice(0, 32)}`;
      const requests: string[] = [];
      const owner: Server = createServer((socket) => {
        socket.on('error', () => socket.destroy());
        socket.on('data', (chunk) => {
          requests.push(chunk.toString());
          reply(chunk.toString(), socket);
        });
      });
      await new Promise<void>((done) => owner.listen(pipe, done));
      cleanup.push(async () => {
        await new Promise((done) => owner.close(done));
        await rm(directory, { recursive: true, force: true });
      });
      return { directory, requests };
    }
    const open = (directory: string, busyRetryMs = 0) =>
      startDesktop({
        root: directory,
        directory,
        openWindow: () => undefined,
        busyRetryMs,
      }) as Promise<{ reused: boolean }>;

    it('does not fall back to the legacy open when the owner answers with something unknown', async () => {
      const { directory, requests } = await existingOwner((_request, socket) =>
        socket.end('not-a-desktop\n'),
      );

      await expect(open(directory)).rejects.toThrow(
        'Unknown desktop control owner.',
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/^open:[a-f0-9]{24}\n$/);
    });

    it('never reopens a manager that answers that it is closing', async () => {
      const { directory, requests } = await existingOwner((_request, socket) =>
        socket.end('wmh-desktop-busy\n'),
      );

      await expect(open(directory)).rejects.toThrow(
        'The existing desktop manager is closing or starting.',
      );
      expect(requests).toHaveLength(1);
    });

    it('asks again when the manager was busy, and reuses it once it answers', async () => {
      let asked = 0;
      const { directory, requests } = await existingOwner((_request, socket) =>
        socket.end(++asked === 1 ? 'wmh-desktop-busy\n' : 'wmh-desktop-v1\n'),
      );

      await expect(open(directory, 5000)).resolves.toMatchObject({
        reused: true,
      });
      expect(requests).toHaveLength(2);
    });

    it('does not send the legacy open when a busy manager goes silent after the wait', async () => {
      let asked = 0;
      const { directory, requests } = await existingOwner(
        (_request, socket) => {
          // Busy first; the second request is accepted inside the wait and
          // closed without a reply only after the wait is over.
          if (++asked === 1) socket.end('wmh-desktop-busy\n');
          else setTimeout(() => socket.destroy(), 2500);
        },
      );

      // The wait is four retry steps long, so a slow runner still sends the
      // second request inside it; that request is closed after the wait.
      await expect(open(directory, 2000)).rejects.toThrow();
      expect(requests).toHaveLength(2);
      expect(requests).not.toContain('open\n');
    });

    it('keeps the busy wait through the pipe bind retries after a handoff', async () => {
      let asked = 0;
      const { directory, requests } = await existingOwner(
        (_request, socket) => {
          // Busy, then an acknowledged handoff while this owner keeps the
          // pipe, so the runtime runs out its bind retries and asks a third
          // time. From then on every request is closed without a reply.
          asked += 1;
          if (asked === 1) socket.end('wmh-desktop-busy\n');
          else if (asked === 2) socket.end('wmh-desktop-handoff\n');
          else socket.destroy();
        },
      );

      // The bind retries take three seconds, so the third request falls
      // inside the six-second wait. If the wait were lost across the bind
      // retries, the silent close would be answered with the legacy open.
      await expect(open(directory, 6000)).rejects.toThrow(
        'The previous hub backend stopped',
      );
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests).not.toContain('open\n');
    }, 20000);

    it('sends no further request when the busy wait ends during the bind retries', async () => {
      let asked = 0;
      const { directory, requests } = await existingOwner(
        (_request, socket) => {
          // Busy, then an acknowledged handoff while this owner keeps the
          // pipe. The two-second wait ends inside the three-second bind
          // retries, so nothing more may be asked.
          asked += 1;
          socket.end(
            asked === 1 ? 'wmh-desktop-busy\n' : 'wmh-desktop-handoff\n',
          );
        },
      );

      // The handoff was acknowledged, so the old backend has stopped and
      // the message must not claim that nothing was stopped.
      await expect(open(directory, 2000)).rejects.toThrow(
        'The previous hub backend stopped, but this installation could not take over the control pipe.',
      );
      expect(requests).toHaveLength(2);
    }, 20000);

    it('sends no legacy open after a handoff that was acknowledged at once', async () => {
      let asked = 0;
      const { directory, requests } = await existingOwner(
        (_request, socket) => {
          // The handoff is acknowledged on the first request, with no busy
          // answer before it. This owner keeps the pipe, and closes every
          // later request without a reply.
          asked += 1;
          if (asked === 1) socket.end('wmh-desktop-handoff\n');
          else socket.destroy();
        },
      );

      await expect(open(directory, 0)).rejects.toThrow(
        'The previous hub backend stopped',
      );
      expect(requests).toHaveLength(2);
      expect(requests).not.toContain('open\n');
    }, 20000);

    it('keeps the hub window free of extensions and account sync', () => {
      expect(
        edgeAppArguments('C:/hub/edge-profile', 'http://127.0.0.1:1/'),
      ).toEqual([
        '--user-data-dir=C:/hub/edge-profile',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--app=http://127.0.0.1:1/',
      ]);
    });

    it('reopens a legacy manager that closes the handoff request without a reply', async () => {
      const { directory, requests } = await existingOwner((request, socket) => {
        if (request === 'open\n') socket.end('wmh-desktop-v1\n');
        else socket.destroy();
      });

      await expect(open(directory)).resolves.toMatchObject({ reused: true });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe('open\n');
    });
  },
);
