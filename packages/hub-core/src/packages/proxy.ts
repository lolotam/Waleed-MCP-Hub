import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

// The only production target. npm reaches it through the proxy below, and the
// hub's own metadata requests go to the same origin.
export const NPM_REGISTRY = {
  host: 'registry.npmjs.org',
  port: 443,
  origin: 'https://registry.npmjs.org',
} as const;

export interface AllowListEntry {
  host: string;
  port: number;
}
export interface AllowListProxyOptions {
  allow: readonly AllowListEntry[];
  downloadCapBytes: number;
  maxTunnels?: number;
  idleTimeoutMs?: number;
}
export interface AllowListProxy {
  url: string;
  capExceeded(): boolean;
  downloadedBytes(): number;
  connections(): readonly string[];
  close(): Promise<void>;
}

// host:port and nothing else: no userinfo, no path, no bracketed address.
const AUTHORITY = /^([A-Za-z0-9.-]{1,253}):([1-9][0-9]{0,4})$/;
const MAX_RECORDED = 1000;
const STATUS: Record<number, string> = {
  403: 'Forbidden',
  405: 'Method Not Allowed',
  407: 'Proxy Authentication Required',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

// The loopback CONNECT proxy npm runs behind. It admits a tunnel only to an
// allow-listed host and port, connects to the allow-listed name rather than
// anything the client sent, counts every byte that comes back and closes every
// tunnel once the download cap is crossed. Nothing is logged.
export async function startAllowListProxy(
  options: AllowListProxyOptions,
): Promise<AllowListProxy> {
  const maxTunnels = options.maxTunnels ?? 16;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(
    `Basic ${Buffer.from(`wmh:${token}`).toString('base64')}`,
  );
  const sockets = new Set<Duplex>();
  const tunnels = new Set<{ client: Socket; upstream: Socket }>();
  const attempts: string[] = [];
  let downloaded = 0;
  let exceeded = false;

  const refuse = (socket: Duplex, status: number): void => {
    socket.end(
      `HTTP/1.1 ${status} ${STATUS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => socket.destroy(),
    );
  };
  const authorized = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers['proxy-authorization'] ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const target = (authority: string): AllowListEntry | null => {
    const match = AUTHORITY.exec(authority);
    if (!match) return null;
    const host = match[1]!.toLowerCase();
    const port = Number(match[2]);
    if (port > 65_535) return null;
    return (
      options.allow.find(
        (entry) => entry.host.toLowerCase() === host && entry.port === port,
      ) ?? null
    );
  };
  const tripCap = (): void => {
    exceeded = true;
    for (const tunnel of tunnels) {
      tunnel.upstream.destroy();
      tunnel.client.destroy();
    }
  };

  const server = createServer((request, response) => {
    // Plain HTTP is never forwarded.
    response.shouldKeepAlive = false;
    response.writeHead(405, { connection: 'close', 'content-length': '0' });
    response.end(() => request.socket.destroy());
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.maxConnections = maxTunnels * 2 + 8;
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_request, socket: Duplex) => refuse(socket, 405));
  server.on('connect', (request, duplex: Duplex, head: Buffer) => {
    // A CONNECT hands over the raw client socket.
    const client = duplex as Socket;
    const authority = (request.url ?? '').slice(0, 300);
    if (attempts.length < MAX_RECORDED) attempts.push(authority);
    client.on('error', () => client.destroy());
    if (!authorized(request)) return refuse(client, 407);
    const entry = target(authority);
    if (!entry) return refuse(client, 403);
    if (exceeded || tunnels.size >= maxTunnels) return refuse(client, 503);

    const upstream = connect(entry.port, entry.host);
    const tunnel = { client, upstream };
    tunnels.add(tunnel);
    let open = false;
    const teardown = (): void => {
      tunnels.delete(tunnel);
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', () => {
      if (open) return teardown();
      tunnels.delete(tunnel);
      upstream.destroy();
      refuse(client, 502);
    });
    client.on('close', teardown);
    upstream.on('close', () => {
      if (open) teardown();
    });
    upstream.on('connect', () => {
      open = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.setTimeout(idleTimeoutMs, teardown);
      client.setTimeout(idleTimeoutMs, teardown);
      upstream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        if (downloaded > options.downloadCapBytes) return tripCap();
        if (!client.write(chunk)) upstream.pause();
      });
      client.on('drain', () => upstream.resume());
      upstream.on('end', () => client.end());
      client.pipe(upstream);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The package proxy did not start.');
  }

  return {
    url: `http://wmh:${token}@127.0.0.1:${address.port}`,
    capExceeded: () => exceeded,
    downloadedBytes: () => downloaded,
    connections: () => [...attempts],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const tunnel of tunnels) tunnel.upstream.destroy();
        for (const socket of sockets) socket.destroy();
      }),
  };
}
