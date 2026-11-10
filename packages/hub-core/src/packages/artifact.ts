import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
  GitHubArtifactSourceSchema,
  type GitHubArtifactSource,
} from '@waleed/contracts';
import { PackageFault } from './fault.js';

export const ROOT_ARTIFACT = 'root-artifact.tgz';
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const require = createRequire(import.meta.url);
const tar = createRequire(require.resolve('npm/package.json'))('tar') as {
  list(options: {
    strict: boolean;
    maxMetaEntrySize: number;
    onReadEntry(
      entry: Readable & { path: string; type: string; size: number },
    ): void;
  }): NodeJS.ReadWriteStream;
};

export function artifactUrl(raw: GitHubArtifactSource): string {
  const source = GitHubArtifactSourceSchema.parse(raw);
  return `https://github.com/${source.repository}/releases/download/${source.tag}/${source.assetName}`;
}

const unsafeUrlCharacters = (text: string): boolean =>
  text.includes('\\') ||
  [...text].some(
    (char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f,
  );

export function isArtifactUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.hostname === 'github.com' ||
      url.hostname === 'release-assets.githubusercontent.com') &&
    !unsafeUrlCharacters(url.href)
  );
}

// No ambient credentials or arbitrary host input. Signed redirect URLs and
// response bodies never leave this function, including in errors.
export async function downloadArtifact(
  source: GitHubArtifactSource,
  signal: AbortSignal,
): Promise<Buffer> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const fetch = async (url: URL, redirects: number): Promise<Buffer> => {
    if (!isArtifactUrl(url)) throw new PackageFault('foreign_host');
    if (bounded.aborted)
      throw new PackageFault(
        signal.aborted ? 'cancelled' : 'registry_unavailable',
      );
    return new Promise((resolve, reject) => {
      let redirected = false;
      const outgoing = request(
        url,
        {
          method: 'GET',
          agent: false,
          rejectUnauthorized: true,
          signal: bounded,
          headers: {
            accept: 'application/octet-stream',
            'accept-encoding': 'identity',
            'user-agent': 'Waleed-MCP-Hub',
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const fail = (
            code: 'foreign_host' | 'install_limit' | 'registry_unavailable',
          ) => {
            response.destroy();
            outgoing.destroy();
            reject(new PackageFault(code));
          };
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            if (!location || redirects >= 3 || unsafeUrlCharacters(location))
              return fail('foreign_host');
            let next: URL;
            try {
              next = new URL(location, url);
            } catch {
              return fail('foreign_host');
            }
            if (!isArtifactUrl(next)) return fail('foreign_host');
            redirected = true;
            response.destroy();
            outgoing.destroy();
            void fetch(next, redirects + 1).then(resolve, reject);
            return;
          }
          if (
            status !== 200 ||
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity')
          )
            return fail('registry_unavailable');
          if (Number(response.headers['content-length']) > MAX_ARTIFACT_BYTES)
            return fail('install_limit');
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ARTIFACT_BYTES) return fail('install_limit');
            chunks.push(chunk);
          });
          response.on('error', () =>
            reject(new PackageFault('registry_unavailable')),
          );
          response.on('aborted', () =>
            reject(new PackageFault('registry_unavailable')),
          );
          response.on('end', () =>
            response.complete
              ? resolve(Buffer.concat(chunks))
              : reject(new PackageFault('registry_unavailable')),
          );
        },
      );
      outgoing.on('error', () => {
        if (!redirected)
          reject(
            new PackageFault(
              signal.aborted ? 'cancelled' : 'registry_unavailable',
            ),
          );
      });
      outgoing.end();
    });
  };
  return fetch(new URL(artifactUrl(source)), 0);
}

const safeArchivePath = (path: string): boolean => {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return (
    normalized.length <= 1024 &&
    normalized.split('/')[0] === 'package' &&
    !/[\\<>:"|?*]/.test(normalized) &&
    ![...normalized].some(
      (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
    ) &&
    normalized.split('/').length <= 64 &&
    normalized
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  );
};

export function artifactIntegrity(
  bytes: Uint8Array,
  source: GitHubArtifactSource,
): string {
  if (bytes.length > MAX_ARTIFACT_BYTES)
    throw new PackageFault('install_limit');
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256)
    throw new PackageFault('integrity_mismatch');
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// Inspect without extraction or executing package code. Limit gzip output
// before tar sees it, and limit tar metadata as well as ordinary file bodies.
export async function inspectArtifact(
  bytes: Buffer,
  source: GitHubArtifactSource,
  signal: AbortSignal,
): Promise<{
  document: Record<string, unknown>;
  integrity: string;
  unpackedSize: number;
  fileCount: number;
}> {
  if (signal.aborted) throw new PackageFault('cancelled');
  const integrity = artifactIntegrity(bytes, source);
  let expanded = 0,
    unpackedSize = 0,
    fileCount = 0;
  let manifest: Buffer | undefined;
  let failure: PackageFault | undefined;
  const seen = new Set<string>();
  const ancestors = new Map<string, { path: string; file: boolean }>();
  const parser = tar.list({
    strict: true,
    maxMetaEntrySize: MAX_MANIFEST_BYTES,
    onReadEntry(entry) {
      const path = entry.path.replace(/\/$/, '');
      const key = path.toLowerCase();
      if (
        !safeArchivePath(entry.path) ||
        seen.has(key) ||
        !['File', 'Directory'].includes(entry.type) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        ++fileCount > 50_000
      ) {
        failure ??= new PackageFault('install_failed');
        entry.resume();
        return;
      }
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const prior = ancestors.get(prefix.toLowerCase());
        const file = i === parts.length && entry.type === 'File';
        if (
          prior &&
          (prior.path !== prefix || prior.file || (file && i === parts.length))
        )
          failure ??= new PackageFault('install_failed');
        ancestors.set(prefix.toLowerCase(), { path: prefix, file });
        if (ancestors.size > 50_000)
          failure ??= new PackageFault('install_limit');
      }
      seen.add(key);
      unpackedSize += entry.size;
      if (unpackedSize > MAX_EXPANDED_BYTES)
        failure ??= new PackageFault('install_limit');
      if (path === 'package/package.json' && entry.type === 'File') {
        if (entry.size > MAX_MANIFEST_BYTES) {
          failure ??= new PackageFault('install_limit');
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        entry.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_MANIFEST_BYTES)
            failure ??= new PackageFault('install_limit');
          else chunks.push(chunk);
        });
        entry.on('end', () => {
          manifest = Buffer.concat(chunks);
        });
      } else entry.resume();
    },
  });
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length;
      callback(
        expanded > MAX_EXPANDED_BYTES
          ? new PackageFault('install_limit')
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(Readable.from([bytes]), createGunzip(), limit, parser, {
      signal,
    });
    if (failure) throw failure;
    if (!manifest) throw new PackageFault('install_failed');
    const document: unknown = JSON.parse(manifest.toString('utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document))
      throw new PackageFault('install_failed');
    return {
      document: document as Record<string, unknown>,
      integrity,
      unpackedSize,
      fileCount,
    };
  } catch (error) {
    if (signal.aborted) throw new PackageFault('cancelled');
    if (error instanceof PackageFault) throw error;
    throw new PackageFault('install_failed');
  }
}
