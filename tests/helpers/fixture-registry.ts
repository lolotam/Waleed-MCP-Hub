import { createHash } from 'node:crypto';
import * as https from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { RegistryTarget } from '../../packages/hub-core/src/packages/npm.js';
import { createTestTls, type TestTls } from './tls.js';

const npmRequire = createRequire(import.meta.url);
const npmManifestPath = npmRequire.resolve('npm/package.json');
const bundledRequire = createRequire(npmManifestPath);
const tar = bundledRequire('tar') as {
  create: (
    options: { gzip: boolean; cwd?: string },
    fileList: readonly string[],
  ) => NodeJS.ReadableStream;
};

export function sha512Integrity(bytes: Buffer | Uint8Array | string): string {
  const hash = createHash('sha512').update(bytes).digest('base64');
  return `sha512-${hash}`;
}

export async function createPackageTarball(
  packageDir: string,
): Promise<Buffer> {
  const stream = tar.create({ gzip: true, cwd: packageDir }, ['package']);
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function createSimpleTarball(
  files: Record<string, string | Buffer>,
  tempBaseDir: string,
): Promise<Buffer> {
  const staging = await mkdtemp(join(tempBaseDir, 'tar-staging-'));
  const pkgDir = join(staging, 'package');
  await mkdir(pkgDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(pkgDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  const buf = await createPackageTarball(staging);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  return buf;
}

export interface FixtureRegistryOptions {
  tls?: TestTls;
  documents?: Map<string, unknown> | Record<string, unknown>;
}

export interface FixtureRegistry {
  origin: string;
  host: '127.0.0.1';
  port: number;
  ca: string;
  registry: RegistryTarget;
  close(): Promise<void>;
  requests(): string[];
  requestHeaders(): Array<Record<string, string | string[] | undefined>>;
  routes: Map<string, unknown>;
  set(path: string, body: unknown): void;
  setPackage(name: string, packument: unknown): void;
  setVersion(name: string, version: string, doc: unknown): void;
  setTarball(path: string, tarball: Buffer): void;
}

export async function createFixtureRegistry(
  optionsOrTls?: TestTls | FixtureRegistryOptions,
): Promise<FixtureRegistry> {
  const options: FixtureRegistryOptions =
    optionsOrTls && 'key' in optionsOrTls
      ? { tls: optionsOrTls }
      : (optionsOrTls ?? {});

  const ownTls = options.tls ? null : await createTestTls();
  const tls = options.tls ?? ownTls!;

  const routes = new Map<string, unknown>();
  if (options.documents) {
    if (options.documents instanceof Map) {
      for (const [k, v] of options.documents) routes.set(k, v);
    } else {
      for (const [k, v] of Object.entries(options.documents)) routes.set(k, v);
    }
  }

  const recordedRequests: string[] = [];
  const recordedHeaders: Array<Record<string, string | string[] | undefined>> =
    [];

  const server = https.createServer(
    {
      key: tls.key,
      cert: tls.cert,
      ca: tls.ca,
    },
    (req, res) => {
      const url = req.url ?? '';
      recordedRequests.push(url);
      recordedHeaders.push(req.headers);

      const rawPath = url.split('?')[0]!;
      const candidates = [
        rawPath,
        rawPath.replaceAll(/%2f/gi, '%2f'),
        rawPath.replaceAll(/%2f/gi, '%2F'),
        rawPath.startsWith('/') ? rawPath.slice(1) : `/${rawPath}`,
      ];
      try {
        candidates.push(decodeURIComponent(rawPath));
      } catch {
        // ignore decode error
      }

      let match: unknown | undefined;
      for (const candidate of candidates) {
        if (routes.has(candidate)) {
          match = routes.get(candidate);
          break;
        }
      }

      if (match === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      if (typeof match === 'function') {
        match(req, res);
        return;
      }

      if (Buffer.isBuffer(match)) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(match.length),
        });
        res.end(match);
        return;
      }

      if (typeof match === 'string') {
        const buf = Buffer.from(match, 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(buf.length),
        });
        res.end(buf);
        return;
      }

      const json = JSON.stringify(match);
      const buf = Buffer.from(json, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(buf.length),
      });
      res.end(buf);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind server');
  }

  const port = address.port;
  const origin = `https://127.0.0.1:${port}`;
  const registry: RegistryTarget = {
    host: '127.0.0.1',
    port,
    origin,
    ca: tls.ca,
  };

  const close = async (): Promise<void> => {
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
    if (ownTls) {
      await ownTls.dispose();
    }
  };

  const set = (path: string, body: unknown): void => {
    const norm = path.startsWith('/') ? path : `/${path}`;
    routes.set(norm, body);
  };

  const setPackage = (name: string, packument: unknown): void => {
    const encoded = name.replaceAll('/', '%2f');
    set(`/${encoded}`, packument);
    set(`/${name}`, packument);
  };

  const setVersion = (name: string, version: string, doc: unknown): void => {
    const encoded = name.replaceAll('/', '%2f');
    set(`/${encoded}/${version}`, doc);
    set(`/${name}/${version}`, doc);
  };

  const setTarball = (path: string, tarball: Buffer): void => {
    set(path, tarball);
  };

  return {
    origin,
    host: '127.0.0.1',
    port,
    ca: tls.ca,
    registry,
    close,
    requests: () => [...recordedRequests],
    requestHeaders: () => [...recordedHeaders],
    routes,
    set,
    setPackage,
    setVersion,
    setTarball,
  };
}
