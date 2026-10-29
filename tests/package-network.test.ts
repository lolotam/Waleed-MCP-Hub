import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { PackageFault } from '../packages/hub-core/src/packages/fault.js';
import {
  createRegistryFetcher,
  registryPath,
} from '../packages/hub-core/src/packages/fetch.js';
import {
  startAllowListProxy,
  type AllowListProxy,
} from '../packages/hub-core/src/packages/proxy.js';
import { createTestTls, type TestTls } from './helpers/tls.js';

interface RawResponse {
  statusLine: string;
  statusCode: number;
  headers: Record<string, string>;
  socket: net.Socket;
  body: Buffer;
}

describe('package network', () => {
  const trackedProxies: AllowListProxy[] = [];
  const trackedServers: Array<http.Server | https.Server | net.Server> = [];
  const trackedSockets: net.Socket[] = [];
  const trackedDisposables: Array<() => Promise<void> | void> = [];

  let sharedTls: TestTls | null = null;

  beforeAll(async () => {
    sharedTls = await createTestTls();
  });

  afterAll(async () => {
    if (sharedTls) {
      await sharedTls.dispose();
      sharedTls = null;
    }
  });

  afterEach(async () => {
    for (const socket of trackedSockets) {
      socket.destroy();
    }
    trackedSockets.length = 0;

    for (const proxy of trackedProxies) {
      await proxy.close().catch(() => undefined);
    }
    trackedProxies.length = 0;

    for (const server of trackedServers) {
      if (
        'closeAllConnections' in server &&
        typeof server.closeAllConnections === 'function'
      ) {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 500);
      }).catch(() => undefined);
    }
    trackedServers.length = 0;

    while (trackedDisposables.length > 0) {
      const dispose = trackedDisposables.pop();
      if (dispose) {
        await Promise.resolve(dispose()).catch(() => undefined);
      }
    }
  });

  function trackSocket<T extends net.Socket>(socket: T): T {
    trackedSockets.push(socket);
    return socket;
  }

  function trackServer<T extends http.Server | https.Server | net.Server>(
    server: T,
  ): T {
    trackedServers.push(server);
    return server;
  }

  async function trackProxy(proxy: AllowListProxy): Promise<AllowListProxy> {
    trackedProxies.push(proxy);
    return proxy;
  }

  function sendRaw(port: number, payload: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const socket = trackSocket(net.connect(port, '127.0.0.1'));
      const chunks: Buffer[] = [];
      let parsed = false;

      socket.on('error', (err) => {
        if (!parsed) reject(err);
      });

      socket.on('connect', () => {
        socket.write(payload);
      });

      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const combined = Buffer.concat(chunks);
        const headerEnd = combined.indexOf('\r\n\r\n');
        if (headerEnd !== -1 && !parsed) {
          parsed = true;
          const headerText = combined.subarray(0, headerEnd).toString('utf8');
          const body = combined.subarray(headerEnd + 4);
          const lines = headerText.split('\r\n');
          const statusLine = lines[0] ?? '';
          const statusCode = Number(statusLine.split(' ')[1]);
          const headers: Record<string, string> = {};
          for (let i = 1; i < lines.length; i++) {
            const colon = lines[i]!.indexOf(':');
            if (colon !== -1) {
              headers[lines[i]!.slice(0, colon).toLowerCase().trim()] = lines[
                i
              ]!.slice(colon + 1).trim();
            }
          }
          resolve({ statusLine, statusCode, headers, socket, body });
        }
      });

      socket.on('close', () => {
        if (!parsed) {
          reject(new Error('Socket closed before status line was received'));
        }
      });
    });
  }

  function sendRawConnect(
    proxyPort: number,
    authority: string,
    options?: {
      authHeader?: string;
      customHeaders?: Record<string, string>;
    },
  ): Promise<RawResponse> {
    let req = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
    if (options?.authHeader !== undefined) {
      req += `Proxy-Authorization: ${options.authHeader}\r\n`;
    }
    if (options?.customHeaders) {
      for (const [key, value] of Object.entries(options.customHeaders)) {
        req += `${key}: ${value}\r\n`;
      }
    }
    req += '\r\n';
    return sendRaw(proxyPort, req);
  }

  function getProxyAuthHeader(proxyUrl: string): string {
    const parsed = new URL(proxyUrl);
    return `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')}`;
  }

  async function createHttpsServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<{ server: https.Server; origin: string; port: number }> {
    if (!sharedTls) {
      throw new Error('Test TLS CA/certificate not initialized');
    }
    const server = trackServer(
      https.createServer({ key: sharedTls.key, cert: sharedTls.cert }, handler),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address() as net.AddressInfo;
    return {
      server,
      origin: `https://127.0.0.1:${address.port}`,
      port: address.port,
    };
  }

  describe('allow-list proxy', () => {
    it('1. url has the expected form and two proxies have different tokens', async () => {
      const proxy1 = await trackProxy(
        await startAllowListProxy({
          allow: [],
          downloadCapBytes: 10_000,
        }),
      );
      const proxy2 = await trackProxy(
        await startAllowListProxy({
          allow: [],
          downloadCapBytes: 10_000,
        }),
      );

      const urlPattern = /^http:\/\/wmh:[0-9a-f]{64}@127\.0\.0\.1:\d+$/;
      expect(proxy1.url).toMatch(urlPattern);
      expect(proxy2.url).toMatch(urlPattern);

      const token1 = new URL(proxy1.url).password;
      const token2 = new URL(proxy2.url).password;
      expect(token1).toHaveLength(64);
      expect(token2).toHaveLength(64);
      expect(token1).not.toBe(token2);
    });

    it('2. correct auth + allow-listed upstream forwards bytes bidirectionally and tracks downloadedBytes', async () => {
      let upstreamReceived = Buffer.alloc(0);
      const echoServer = trackServer(
        net.createServer((sock) => {
          sock.on('data', (chunk) => {
            upstreamReceived = Buffer.concat([upstreamReceived, chunk]);
            sock.write(chunk);
          });
        }),
      );
      await new Promise<void>((resolve) =>
        echoServer.listen(0, '127.0.0.1', () => resolve()),
      );
      const echoPort = (echoServer.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: echoPort }],
          downloadCapBytes: 10_000,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);
      const authHeader = getProxyAuthHeader(proxy.url);

      const connectRes = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${echoPort}`,
        {
          authHeader,
        },
      );
      expect(connectRes.statusCode).toBe(200);
      expect(connectRes.statusLine).toContain('200');

      const clientSocket = connectRes.socket;
      const testPayload = Buffer.from('hello-allow-list-proxy-echo');

      const replyPromise = new Promise<Buffer>((resolve, reject) => {
        const received: Buffer[] = [];
        clientSocket.on('data', (chunk) => {
          received.push(chunk);
          const all = Buffer.concat(received);
          if (all.length >= testPayload.length) {
            resolve(all);
          }
        });
        clientSocket.on('error', reject);
      });

      clientSocket.write(testPayload);
      const reply = await replyPromise;

      expect(upstreamReceived).toEqual(testPayload);
      expect(reply).toEqual(testPayload);
      expect(proxy.downloadedBytes()).toBe(testPayload.length);

      clientSocket.destroy();
    });

    it('3. missing auth, wrong token, and different length token give 407 without upstream connection', async () => {
      let upstreamConnections = 0;
      const upstream = trackServer(
        net.createServer((sock) => {
          upstreamConnections++;
          sock.destroy();
        }),
      );
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', () => resolve()),
      );
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: upstreamPort }],
          downloadCapBytes: 10_000,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);

      // Missing Proxy-Authorization
      const resMissing = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}`,
      );
      expect(resMissing.statusCode).toBe(407);

      // Wrong token (same length: 64 hex characters)
      const wrongTokenSameLength = 'f'.repeat(64);
      const wrongAuthSameLength = `Basic ${Buffer.from(`wmh:${wrongTokenSameLength}`).toString('base64')}`;
      const resWrongToken = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}`,
        {
          authHeader: wrongAuthSameLength,
        },
      );
      expect(resWrongToken.statusCode).toBe(407);

      // Token of different length (e.g. 16 characters)
      const diffLengthToken = '0'.repeat(16);
      const diffLengthAuth = `Basic ${Buffer.from(`wmh:${diffLengthToken}`).toString('base64')}`;
      const resDiffLength = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}`,
        {
          authHeader: diffLengthAuth,
        },
      );
      expect(resDiffLength.statusCode).toBe(407);

      expect(upstreamConnections).toBe(0);
    });

    it('4. host not allowed, wrong port, userinfo, trailing chars, non-decimal port get 403; uppercase host is admitted', async () => {
      let upstreamConnections = 0;
      const upstream = trackServer(
        net.createServer((sock) => {
          upstreamConnections++;
          sock.destroy();
        }),
      );
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', () => resolve()),
      );
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [
            { host: '127.0.0.1', port: upstreamPort },
            { host: 'localhost', port: upstreamPort },
          ],
          downloadCapBytes: 10_000,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);
      const authHeader = getProxyAuthHeader(proxy.url);

      // Host not in allow-list
      const resNotAllowed = await sendRawConnect(
        proxyPort,
        `127.0.0.2:${upstreamPort}`,
        { authHeader },
      );
      expect(resNotAllowed.statusCode).toBe(403);
      expect(upstreamConnections).toBe(0);

      // Right host, wrong port
      const wrongPort = upstreamPort === 65535 ? 65534 : upstreamPort + 1;
      const resWrongPort = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${wrongPort}`,
        { authHeader },
      );
      expect(resWrongPort.statusCode).toBe(403);
      expect(upstreamConnections).toBe(0);

      // Authority with userinfo
      const resUserInfo = await sendRawConnect(
        proxyPort,
        `a@127.0.0.1:${upstreamPort}`,
        { authHeader },
      );
      expect(resUserInfo.statusCode).toBe(403);
      expect(upstreamConnections).toBe(0);

      // Authority with trailing characters
      const resTrailing = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}/extra`,
        { authHeader },
      );
      expect(resTrailing.statusCode).toBe(403);
      expect(upstreamConnections).toBe(0);

      // Non-decimal port
      const resNonDecimal = await sendRawConnect(
        proxyPort,
        '127.0.0.1:8080abc',
        { authHeader },
      );
      expect(resNonDecimal.statusCode).toBe(403);
      expect(upstreamConnections).toBe(0);

      // Upper-case variant of allowed host name (must be admitted)
      const resUpperCase = await sendRawConnect(
        proxyPort,
        `LOCALHOST:${upstreamPort}`,
        { authHeader },
      );
      expect(resUpperCase.statusCode).toBe(200);
      expect(upstreamConnections).toBe(1);
    });

    it('5. plain GET to proxy returns 405 without upstream connection', async () => {
      let upstreamConnections = 0;
      const upstream = trackServer(
        net.createServer((sock) => {
          upstreamConnections++;
          sock.destroy();
        }),
      );
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', () => resolve()),
      );
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: upstreamPort }],
          downloadCapBytes: 10_000,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);

      const res = await sendRaw(
        proxyPort,
        `GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`,
      );
      expect(res.statusCode).toBe(405);
      expect(upstreamConnections).toBe(0);
    });

    it('6. download cap exceeded closes socket, marks capExceeded, and new CONNECT gets 503', async () => {
      const upstream = trackServer(
        net.createServer((sock) => {
          sock.write(Buffer.alloc(200, 'x'));
        }),
      );
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', () => resolve()),
      );
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: upstreamPort }],
          downloadCapBytes: 100,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);
      const authHeader = getProxyAuthHeader(proxy.url);

      const res1 = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}`,
        {
          authHeader,
        },
      );
      expect(res1.statusCode).toBe(200);

      // Client socket should be closed by proxy due to download cap trip
      await new Promise<void>((resolve) => {
        if (res1.socket.destroyed) {
          resolve();
        } else {
          res1.socket.on('close', () => resolve());
        }
      });

      expect(proxy.capExceeded()).toBe(true);

      // New correct CONNECT now receives 503
      const res2 = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}`,
        {
          authHeader,
        },
      );
      expect(res2.statusCode).toBe(503);
    });

    it('7. maxTunnels: 1 rejects second concurrent CONNECT with 503', async () => {
      const upstream = trackServer(
        net.createServer(() => {
          // Keep open
        }),
      );
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', () => resolve()),
      );
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: upstreamPort }],
          downloadCapBytes: 10_000,
          maxTunnels: 1,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);
      const authHeader = getProxyAuthHeader(proxy.url);

      const res1 = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}`,
        {
          authHeader,
        },
      );
      expect(res1.statusCode).toBe(200);

      const res2 = await sendRawConnect(
        proxyPort,
        `127.0.0.1:${upstreamPort}`,
        {
          authHeader,
        },
      );
      expect(res2.statusCode).toBe(503);

      res1.socket.destroy();
    });

    it('8. idleTimeoutMs: 100 closes an idle tunnel', async () => {
      const upstream = trackServer(
        net.createServer(() => {
          // Keep open without sending data
        }),
      );
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', () => resolve()),
      );
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: upstreamPort }],
          downloadCapBytes: 10_000,
          idleTimeoutMs: 100,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);
      const authHeader = getProxyAuthHeader(proxy.url);

      const res = await sendRawConnect(proxyPort, `127.0.0.1:${upstreamPort}`, {
        authHeader,
      });
      expect(res.statusCode).toBe(200);

      const start = Date.now();
      await new Promise<void>((resolve) => {
        if (res.socket.destroyed) {
          resolve();
        } else {
          res.socket.on('close', () => resolve());
        }
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(80);
    });

    it('9. connections() lists requested authorities in order and contains no headers or token', async () => {
      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: 8080 }],
          downloadCapBytes: 10_000,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);
      const token = new URL(proxy.url).password;
      const authHeader = getProxyAuthHeader(proxy.url);

      await sendRawConnect(proxyPort, 'target1.test:8080', { authHeader });
      await sendRawConnect(proxyPort, 'target2.test:9090');
      await sendRawConnect(proxyPort, 'target3.test:7070', {
        authHeader: 'Basic invalid',
      });

      const list = proxy.connections();
      expect(list).toEqual([
        'target1.test:8080',
        'target2.test:9090',
        'target3.test:7070',
      ]);

      for (const item of list) {
        expect(item).not.toContain(token);
        expect(item.toLowerCase()).not.toContain('authorization');
        expect(item.toLowerCase()).not.toContain('proxy');
        expect(item.toLowerCase()).not.toContain('basic');
      }
    });

    it('10. close() resolves and closes open tunnels', async () => {
      const upstream = trackServer(
        net.createServer(() => {
          // Keep open
        }),
      );
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', () => resolve()),
      );
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      const proxy = await trackProxy(
        await startAllowListProxy({
          allow: [{ host: '127.0.0.1', port: upstreamPort }],
          downloadCapBytes: 10_000,
        }),
      );
      const proxyPort = Number(new URL(proxy.url).port);
      const authHeader = getProxyAuthHeader(proxy.url);

      const res = await sendRawConnect(proxyPort, `127.0.0.1:${upstreamPort}`, {
        authHeader,
      });
      expect(res.statusCode).toBe(200);

      const clientClosedPromise = new Promise<void>((resolve) => {
        if (res.socket.destroyed) {
          resolve();
        } else {
          res.socket.on('close', () => resolve());
        }
      });

      await proxy.close();
      await clientClosedPromise;
      expect(res.socket.destroyed).toBe(true);
    });
  });

  describe('registry fetcher', () => {
    it('11. 200 with JSON parses value, request sends accept-encoding identity and accept header', async () => {
      let recordedHeaders: http.IncomingHttpHeaders | null = null;
      const { origin } = await createHttpsServer((req, res) => {
        recordedHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'test-pkg', version: '1.0.0' }));
      });

      if (!sharedTls) throw new Error('Missing TLS');
      const fetcher = createRegistryFetcher({ origin, ca: sharedTls.ca });

      // Default accept header
      const data = await fetcher.getJson('/test-pkg', { maxBytes: 10_000 });
      expect(data).toEqual({ name: 'test-pkg', version: '1.0.0' });
      expect(recordedHeaders?.['accept-encoding']).toBe('identity');
      expect(recordedHeaders?.['accept']).toBe('application/json');

      // Custom accept header
      const customData = await fetcher.getJson('/test-pkg', {
        maxBytes: 10_000,
        accept: 'application/vnd.npm.install-v1+json',
      });
      expect(customData).toEqual({ name: 'test-pkg', version: '1.0.0' });
      expect(recordedHeaders?.['accept-encoding']).toBe('identity');
      expect(recordedHeaders?.['accept']).toBe(
        'application/vnd.npm.install-v1+json',
      );
    });

    it('12. 404 returns null; 500 throws PackageFault registry_unavailable', async () => {
      const { origin } = await createHttpsServer((req, res) => {
        if (req.url === '/missing') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
        } else {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error' }));
        }
      });

      if (!sharedTls) throw new Error('Missing TLS');
      const fetcher = createRegistryFetcher({ origin, ca: sharedTls.ca });

      const notFound = await fetcher.getJson('/missing', { maxBytes: 10_000 });
      expect(notFound).toBeNull();

      const serverErrorPromise = fetcher.getJson('/error', {
        maxBytes: 10_000,
      });
      await expect(serverErrorPromise).rejects.toMatchObject({
        code: 'registry_unavailable',
      });
      await expect(serverErrorPromise).rejects.toBeInstanceOf(PackageFault);
    });

    it('13. 302 redirect rejects with registry_unavailable and target receives zero requests', async () => {
      let server2Requests = 0;
      const server2 = await createHttpsServer((_req, res) => {
        server2Requests++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });

      const server1 = await createHttpsServer((_req, res) => {
        res.writeHead(302, { location: `${server2.origin}/redirected` });
        res.end();
      });

      if (!sharedTls) throw new Error('Missing TLS');
      const fetcher = createRegistryFetcher({
        origin: server1.origin,
        ca: sharedTls.ca,
      });

      const redirectPromise = fetcher.getJson('/redirect', {
        maxBytes: 10_000,
      });
      await expect(redirectPromise).rejects.toMatchObject({
        code: 'registry_unavailable',
      });
      await expect(redirectPromise).rejects.toBeInstanceOf(PackageFault);
      expect(server2Requests).toBe(0);
    });

    it('14. content-length above maxBytes and chunked body past maxBytes throw install_limit', async () => {
      const { origin } = await createHttpsServer((req, res) => {
        if (req.url === '/oversized-header') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': '2000',
          });
          res.end(Buffer.alloc(2000, 32));
        } else if (req.url === '/oversized-chunked') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(Buffer.alloc(300, 32));
          res.write(Buffer.alloc(300, 32));
          res.end();
        }
      });

      if (!sharedTls) throw new Error('Missing TLS');
      const fetcher = createRegistryFetcher({ origin, ca: sharedTls.ca });

      const headerPromise = fetcher.getJson('/oversized-header', {
        maxBytes: 500,
      });
      await expect(headerPromise).rejects.toMatchObject({
        code: 'install_limit',
      });
      await expect(headerPromise).rejects.toBeInstanceOf(PackageFault);

      const chunkedPromise = fetcher.getJson('/oversized-chunked', {
        maxBytes: 500,
      });
      await expect(chunkedPromise).rejects.toMatchObject({
        code: 'install_limit',
      });
      await expect(chunkedPromise).rejects.toBeInstanceOf(PackageFault);
    });

    it('15. invalid JSON throws registry_unavailable and error does not contain body text', async () => {
      const secretPayload = 'sensitive-unparsed-body-content-xyz987';
      const { origin } = await createHttpsServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{ ${secretPayload}: unquoted invalid json syntax`);
      });

      if (!sharedTls) throw new Error('Missing TLS');
      const fetcher = createRegistryFetcher({ origin, ca: sharedTls.ca });

      let caughtError: unknown = null;
      try {
        await fetcher.getJson('/invalid-json', { maxBytes: 10_000 });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(PackageFault);
      expect(caughtError).toMatchObject({ code: 'registry_unavailable' });
      expect((caughtError as Error).message).not.toContain(secretPayload);
    });

    it('16. aborted signals throw cancelled; timeout throws registry_unavailable', async () => {
      let midAbortRes: http.ServerResponse | null = null;
      const { origin } = await createHttpsServer((req, res) => {
        if (req.url === '/mid-abort') {
          midAbortRes = res;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"streaming":');
          // intentionally leave open
        } else if (req.url === '/never-answers') {
          // intentionally never reply
        }
      });

      if (!sharedTls) throw new Error('Missing TLS');
      const fetcher = createRegistryFetcher({ origin, ca: sharedTls.ca });

      // Pre-aborted signal
      const preAborted = AbortSignal.abort();
      const preAbortPromise = fetcher.getJson('/pre-abort', {
        maxBytes: 10_000,
        signal: preAborted,
      });
      await expect(preAbortPromise).rejects.toMatchObject({
        code: 'cancelled',
      });
      await expect(preAbortPromise).rejects.toBeInstanceOf(PackageFault);

      // Aborted mid-response
      const controller = new AbortController();
      const midAbortPromise = fetcher.getJson('/mid-abort', {
        maxBytes: 10_000,
        signal: controller.signal,
      });
      while (!midAbortRes) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      await expect(midAbortPromise).rejects.toMatchObject({
        code: 'cancelled',
      });
      await expect(midAbortPromise).rejects.toBeInstanceOf(PackageFault);

      // Timeout
      const timeoutFetcher = createRegistryFetcher({
        origin,
        ca: sharedTls.ca,
        timeoutMs: 100,
      });
      const timeoutPromise = timeoutFetcher.getJson('/never-answers', {
        maxBytes: 10_000,
      });
      await expect(timeoutPromise).rejects.toMatchObject({
        code: 'registry_unavailable',
      });
      await expect(timeoutPromise).rejects.toBeInstanceOf(PackageFault);
    });

    it('17. without ca, the self-signed test server certificate is rejected', async () => {
      const { origin } = await createHttpsServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });

      const fetcherNoCa = createRegistryFetcher({ origin });
      const promise = fetcherNoCa.getJson('/test', { maxBytes: 10_000 });
      await expect(promise).rejects.toMatchObject({
        code: 'registry_unavailable',
      });
      await expect(promise).rejects.toBeInstanceOf(PackageFault);
    });

    it('18. creation throws for invalid origins; getJson rejects unsafe paths without contacting server', async () => {
      const invalidOrigins = [
        'http://127.0.0.1:8080',
        'https://127.0.0.1:8080/prefix',
        'https://127.0.0.1:8080/?q=1',
        'https://127.0.0.1:8080?q=1',
        'https://user:pass@127.0.0.1:8080',
        'https://127.0.0.1:8080/#hash',
        'https://127.0.0.1:8080#hash',
      ];
      for (const invalidOrigin of invalidOrigins) {
        expect(() => createRegistryFetcher({ origin: invalidOrigin })).toThrow(
          'The registry origin must be a bare https origin.',
        );
      }

      let serverRequestCount = 0;
      const { origin } = await createHttpsServer((_req, res) => {
        serverRequestCount++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });

      if (!sharedTls) throw new Error('Missing TLS');
      const fetcher = createRegistryFetcher({ origin, ca: sharedTls.ca });

      const unsafePaths = [
        'no-leading-slash',
        'pkg/1.0.0',
        '/a/../b',
        '/../a',
        '/a/..',
        '/foo\\bar',
        '/foo?bar',
        '/foo#bar',
        '/foo\nbar',
        '/foo\rbar',
        '/foo\0bar',
        '/foo\x1fbar',
        '/foo\x7fbar',
        '/foo%2ebar',
      ];

      for (const unsafePath of unsafePaths) {
        const promise = fetcher.getJson(unsafePath, { maxBytes: 10_000 });
        await expect(promise).rejects.toMatchObject({
          code: 'registry_unavailable',
        });
        await expect(promise).rejects.toBeInstanceOf(PackageFault);
      }

      expect(serverRequestCount).toBe(0);
    });

    it('19. registryPath formats scoped and unscoped names; rejects invalid names and versions with package_not_found', () => {
      expect(registryPath('@scope/srv', '1.2.3')).toBe('/@scope%2fsrv/1.2.3');
      expect(registryPath('srv')).toBe('/srv');
      expect(registryPath('srv', 'latest')).toBe('/srv/latest');

      const invalidNames = ['../x', 'A B', ''];
      for (const name of invalidNames) {
        expect(() => registryPath(name)).toThrow(PackageFault);
        try {
          registryPath(name);
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(PackageFault);
          expect((err as PackageFault).code).toBe('package_not_found');
        }
      }

      const invalidVersions = ['^1.0.0', '1.2'];
      for (const ver of invalidVersions) {
        expect(() => registryPath('srv', ver)).toThrow(PackageFault);
        try {
          registryPath('srv', ver);
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(PackageFault);
          expect((err as PackageFault).code).toBe('package_not_found');
        }
      }
    });
  });
});
