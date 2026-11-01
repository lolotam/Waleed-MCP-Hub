// A manager that is still shutting down must not be reopened through the
// legacy protocol: it would acknowledge `open` and leave no desktop behind.
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The desktop runtime is a plain ES module without types.
import { startDesktop } from '../scripts/desktop-runtime.mjs';

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
    const open = (directory: string) =>
      startDesktop({
        root: directory,
        directory,
        openWindow: () => undefined,
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
