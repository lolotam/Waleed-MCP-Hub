import { request } from 'node:https';
import { PackageProvenanceSchema } from '@waleed/contracts';
import { PackageFault } from './fault.js';

export interface RegistryFetcherOptions {
  origin: string;
  ca?: string | Buffer;
  timeoutMs?: number;
}
export interface GetJsonInit {
  maxBytes: number;
  accept?: string;
  signal?: AbortSignal;
}
export interface RegistryFetcher {
  getJson(path: string, init: GetJsonInit): Promise<unknown | null>;
}

const unavailable = () => new PackageFault('registry_unavailable');
// A request path stays a plain path on the one origin: no query, no fragment,
// no backslash, no control character and no dot segment, encoded or not.
const safePath = (path: string): boolean =>
  path.startsWith('/') &&
  !/[\\?#]/.test(path) &&
  ![...path].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  }) &&
  !/%2e/i.test(path) &&
  path.split('/').every((segment) => segment !== '..' && segment !== '.');

// The hub's own registry reader. The origin is fixed at creation, redirects
// are never followed and every body is size-capped, so a response can neither
// send the hub to another host nor grow without bound. Bodies are never logged
// and never placed in an error.
export function createRegistryFetcher(
  options: RegistryFetcherOptions,
): RegistryFetcher {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    /[?#]/.test(options.origin)
  )
    throw new Error('The registry origin must be a bare https origin.');
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    getJson(path, init) {
      return new Promise<unknown>((resolve, reject) => {
        if (!safePath(path)) return reject(unavailable());
        if (!Number.isSafeInteger(init.maxBytes) || init.maxBytes < 1)
          return reject(new PackageFault('install_limit'));
        if (init.signal?.aborted) return reject(new PackageFault('cancelled'));
        let settled = false;
        const settle = (outcome: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          init.signal?.removeEventListener('abort', onAbort);
          outcome();
        };
        const fail = (fault: PackageFault): void =>
          settle(() => {
            outgoing.destroy();
            reject(fault);
          });
        const onAbort = (): void => fail(new PackageFault('cancelled'));

        const outgoing = request(
          {
            protocol: 'https:',
            hostname: origin.hostname,
            port: origin.port === '' ? 443 : Number(origin.port),
            path,
            method: 'GET',
            agent: false,
            rejectUnauthorized: true,
            ...(options.ca === undefined ? {} : { ca: options.ca }),
            headers: {
              accept: init.accept ?? 'application/json',
              'accept-encoding': 'identity',
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if (status === 404) {
              response.resume();
              return settle(() => {
                outgoing.destroy();
                resolve(null);
              });
            }
            const encoding = response.headers['content-encoding'];
            if (status !== 200 || (encoding && encoding !== 'identity'))
              return fail(unavailable());
            const declared = Number(response.headers['content-length']);
            if (Number.isFinite(declared) && declared > init.maxBytes)
              return fail(new PackageFault('install_limit'));
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > init.maxBytes)
                return fail(new PackageFault('install_limit'));
              chunks.push(chunk);
            });
            response.on('error', () => fail(unavailable()));
            response.on('aborted', () => fail(unavailable()));
            response.on('end', () => {
              if (settled) return;
              let value: unknown;
              try {
                value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                return fail(unavailable());
              }
              settle(() => resolve(value));
            });
            response.on('close', () => {
              if (!response.complete) fail(unavailable());
            });
          },
        );
        const timer = setTimeout(() => fail(unavailable()), timeoutMs);
        init.signal?.addEventListener('abort', onAbort, { once: true });
        outgoing.on('error', () => fail(unavailable()));
        outgoing.end();
      });
    },
  };
}

// The registry path of a package document. A scoped name keeps its scope in
// one path segment, as the registry expects (`/@scope%2fname`).
export function registryPath(name: string, version?: string): string {
  if (!PackageProvenanceSchema.shape.name.safeParse(name).success)
    throw new PackageFault('package_not_found');
  if (
    version !== undefined &&
    version !== 'latest' &&
    !PackageProvenanceSchema.shape.version.safeParse(version).success
  )
    throw new PackageFault('package_not_found');
  const encoded = name.replaceAll('/', '%2f');
  return version === undefined ? `/${encoded}` : `/${encoded}/${version}`;
}
