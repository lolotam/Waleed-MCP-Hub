import { inflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, lstat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  McpbManifestSchema,
  McpbPathSchema,
  McpbBundleSchema,
  MCPB_MAX_ARCHIVE_BYTES,
  MCPB_MAX_UNCOMPRESSED_BYTES,
  MCPB_MAX_FILES,
  type McpbManifest,
  type McpbBundle,
  type Connector,
} from '@waleed/contracts';
import { HubError } from '../errors.js';
import { hashBytes } from '../runtime/registry.js';
import { assertNoLinks } from './managed-files.js';
import type { PackageLaunch } from './packages.js';
import { assertBinding } from '../auth/bindings.js';
import { createWindowsDiscoveryPorts } from './discovery-files.js';
import {
  createWindowsProcessRunner,
  systemModulePath,
} from './native/process-runner.js';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';

const invalid = () =>
  new HubError(
    'invalid',
    'Bundle is invalid, unsafe, unsupported, or exceeds installation limits.',
  );
export interface InspectedMcpb {
  manifest: McpbManifest;
  archiveHash: string;
  files: Map<string, Buffer>;
  uncompressedBytes: number;
}
export function clearMcpb(bundle: InspectedMcpb) {
  for (const bytes of bundle.files.values()) bytes.fill(0);
  bundle.files.clear();
}

// Deliberately narrow ZIP reader: single-disk, non-ZIP64, stored/deflated files.
// Central and local headers must agree. No path from an archive is delegated to
// an extractor or filesystem before the entire archive has passed validation.
export function inspectMcpb(archive: Buffer): InspectedMcpb {
  const files = new Map<string, Buffer>();
  try {
    if (archive.length < 22 || archive.length > MCPB_MAX_ARCHIVE_BYTES)
      throw invalid();
    let end = -1;
    for (
      let at = archive.length - 22;
      at >= Math.max(0, archive.length - 65557);
      at--
    ) {
      if (
        archive.readUInt32LE(at) === 0x06054b50 &&
        at + 22 + archive.readUInt16LE(at + 20) === archive.length
      ) {
        end = at;
        break;
      }
    }
    if (end < 0) throw invalid();
    const count = archive.readUInt16LE(end + 10),
      centralSize = archive.readUInt32LE(end + 12),
      centralStart = archive.readUInt32LE(end + 16);
    if (
      !count ||
      count > MCPB_MAX_FILES ||
      archive.readUInt16LE(end + 4) ||
      archive.readUInt16LE(end + 6) ||
      archive.readUInt16LE(end + 8) !== count ||
      centralStart + centralSize !== end
    )
      throw invalid();
    const names = new Map<string, boolean>(),
      spellings = new Map<string, string>(),
      ranges: Array<[number, number]> = [];
    let at = centralStart,
      total = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > end || archive.readUInt32LE(at) !== 0x02014b50)
        throw invalid();
      const flags = archive.readUInt16LE(at + 8),
        method = archive.readUInt16LE(at + 10),
        checksum = archive.readUInt32LE(at + 16),
        compressed = archive.readUInt32LE(at + 20),
        size = archive.readUInt32LE(at + 24),
        nameLength = archive.readUInt16LE(at + 28),
        extraLength = archive.readUInt16LE(at + 30),
        commentLength = archive.readUInt16LE(at + 32),
        attributes = archive.readUInt32LE(at + 38),
        offset = archive.readUInt32LE(at + 42);
      if (
        flags & ~0x080e ||
        flags & 1 ||
        ![0, 8].includes(method) ||
        (method === 0 && flags & 6) ||
        archive.readUInt16LE(at + 34) ||
        compressed === 0xffffffff ||
        size === 0xffffffff ||
        offset === 0xffffffff ||
        at + 46 + nameLength + extraLength + commentLength > end
      )
        throw invalid();
      const nameBytes = archive.subarray(at + 46, at + 46 + nameLength),
        raw = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes),
        directory = raw.endsWith('/'),
        name = directory ? raw.slice(0, -1) : raw;
      McpbPathSchema.parse(name);
      if (!(flags & 0x800) && [...raw].some((char) => char.charCodeAt(0) > 127))
        throw invalid();
      const type = (attributes >>> 16) & 0xf000;
      if (
        (type && type !== (directory ? 0x4000 : 0x8000)) ||
        attributes & 0x400 ||
        attributes & 0x40 ||
        (directory && size !== 0)
      )
        throw invalid();
      const folded = name.toLowerCase();
      if (names.has(folded)) throw invalid();
      names.set(folded, directory);
      const components = name.split('/');
      for (let depth = 1; depth <= components.length; depth++) {
        const prefix = components.slice(0, depth).join('/'),
          key = prefix.toLowerCase(),
          prior = spellings.get(key);
        if (prior && prior !== prefix) throw invalid();
        spellings.set(key, prefix);
      }
      if (
        spellings.size > MCPB_MAX_FILES ||
        (name === 'manifest.json' && size > 64 * 1024)
      )
        throw invalid();
      for (
        let extra = at + 46 + nameLength;
        extra < at + 46 + nameLength + extraLength;
      ) {
        if (extra + 4 > at + 46 + nameLength + extraLength) throw invalid();
        const tag = archive.readUInt16LE(extra),
          length = archive.readUInt16LE(extra + 2);
        extra += 4 + length;
        if (
          [0x0001, 0x7075].includes(tag) ||
          extra > at + 46 + nameLength + extraLength
        )
          throw invalid();
      }
      total += size;
      if (total > MCPB_MAX_UNCOMPRESSED_BYTES) throw invalid();
      if (
        offset + 30 > centralStart ||
        archive.readUInt32LE(offset) !== 0x04034b50 ||
        archive.readUInt16LE(offset + 6) !== flags ||
        archive.readUInt16LE(offset + 8) !== method ||
        archive.readUInt16LE(offset + 26) !== nameLength
      )
        throw invalid();
      const localExtra = archive.readUInt16LE(offset + 28),
        start = offset + 30 + nameLength + localExtra,
        finish = start + compressed;
      if (
        finish > centralStart ||
        !archive
          .subarray(offset + 30, offset + 30 + nameLength)
          .equals(nameBytes)
      )
        throw invalid();
      if (
        !(flags & 8) &&
        (archive.readUInt32LE(offset + 14) !== checksum ||
          archive.readUInt32LE(offset + 18) !== compressed ||
          archive.readUInt32LE(offset + 22) !== size)
      )
        throw invalid();
      let rangeEnd = finish;
      if (flags & 8) {
        let descriptor = finish;
        if (
          descriptor + 4 <= centralStart &&
          archive.readUInt32LE(descriptor) === 0x08074b50
        )
          descriptor += 4;
        if (
          descriptor + 12 > centralStart ||
          archive.readUInt32LE(descriptor) !== checksum ||
          archive.readUInt32LE(descriptor + 4) !== compressed ||
          archive.readUInt32LE(descriptor + 8) !== size
        )
          throw invalid();
        rangeEnd = descriptor + 12;
      }
      if (ranges.some(([from, to]) => offset < to && rangeEnd > from))
        throw invalid();
      ranges.push([offset, rangeEnd]);
      {
        const compressedBytes = archive.subarray(start, finish);
        const data =
          method === 0
            ? Buffer.from(compressedBytes)
            : inflateRawSync(compressedBytes, {
                maxOutputLength: Math.max(1, size),
              });
        if (data.length !== size || crc32(data) !== checksum) {
          data.fill(0);
          throw invalid();
        }
        if (!directory) files.set(name, data);
        else data.fill(0);
      }
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== end) throw invalid();
    for (const name of names.keys()) {
      const parts = name.split('/');
      parts.pop();
      while (parts.length) {
        if (names.get(parts.join('/')) === false) throw invalid();
        parts.pop();
      }
    }
    const bytes = files.get('manifest.json');
    if (!bytes || bytes.length > 64 * 1024) throw invalid();
    const manifest = McpbManifestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (!files.has(manifest.server.entry_point)) throw invalid();
    validateTemplates(manifest);
    return {
      manifest,
      files,
      archiveHash: hashBytes(archive),
      uncompressedBytes: total,
    };
  } catch {
    for (const data of files.values()) data.fill(0);
    throw invalid();
  }
}

function validateTemplates(manifest: McpbManifest) {
  const fields = manifest.user_config ?? manifest.configuration ?? {};
  const check = (value: string, environment = false) => {
    const rest = value.replace(
      /\$\{(__dirname|user_config\.([a-zA-Z][a-zA-Z0-9_]*))\}/g,
      (_match: string, token: string, key: string) => {
        if (token === '__dirname') return '';
        if (
          !Object.hasOwn(fields, key) ||
          (!environment && (fields[key]!.sensitive || fields[key]!.secret))
        )
          throw invalid();
        return '';
      },
    );
    if (rest.includes('${')) throw invalid();
  };
  for (const value of manifest.server.mcp_config.args ?? []) check(value);
  const env = manifest.server.mcp_config.env ?? {};
  if (
    new Set(Object.keys(env).map((key) => key.toUpperCase())).size !==
    Object.keys(env).length
  )
    throw invalid();
  for (const [key, value] of Object.entries(env)) {
    assertBinding('environment', key, 'raw');
    check(value, true);
  }
  // No silently unused protected field: it must have an environment destination.
  for (const [key, field] of Object.entries(fields))
    if (
      (field.secret || field.sensitive) &&
      !Object.values(env).some((value) =>
        value.includes('${user_config.' + key + '}'),
      )
    )
      throw invalid();
}

export interface McpbAdapter {
  path(id: string): string;
  executable(manifest: McpbManifest, id: string): Promise<string>;
  extract(bundle: InspectedMcpb, id: string): Promise<McpbBundle>;
  remove(id: string): Promise<void>;
  prepare(
    connector: Extract<Connector, { executionMode: 'native' }>,
  ): Promise<PackageLaunch>;
}
export class McpbExtractionFault extends Error {
  constructor(readonly restored: boolean) {
    super('Bundle extraction failed.');
  }
}
export function createMcpbAdapter(
  directory: string,
  tools: {
    node: string;
    python?: string;
    protect?: (path: string) => Promise<void>;
  },
): McpbAdapter {
  const root = join(directory, 'packages', 'bundles');
  const path = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid();
    return join(root, id);
  };
  return {
    path,
    async executable(manifest, id) {
      if (manifest.server.type === 'binary')
        return join(path(id), ...manifest.server.entry_point.split('/'));
      const executable =
        manifest.server.type === 'node' ? tools.node : tools.python;
      if (!executable)
        throw new HubError(
          'unavailable',
          'A supported local runtime is required. No runtime or dependencies are installed by bundle import.',
        );
      await assertNoLinks(executable);
      if (!(await lstat(executable)).isFile()) throw invalid();
      return executable;
    },
    async extract(bundle, id) {
      // Validate the extraction seam as well as ZIP inspection; no caller can
      // turn an in-memory map into an unchecked filesystem path.
      const paths = new Set<string>();
      let total = 0;
      if (!bundle.files.size || bundle.files.size > MCPB_MAX_FILES)
        throw invalid();
      for (const [name, bytes] of bundle.files) {
        McpbPathSchema.parse(name);
        total += bytes.length;
        if (total > MCPB_MAX_UNCOMPRESSED_BYTES) throw invalid();
        const parts = name.split('/');
        for (let depth = 1; depth <= parts.length; depth++)
          paths.add(parts.slice(0, depth).join('/').toLowerCase());
        if (paths.size > MCPB_MAX_FILES) throw invalid();
      }
      await assertNoLinks(root, true);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await assertNoLinks(root);
      await tools.protect?.(root);
      const destination = path(id);
      await mkdir(destination, { mode: 0o700 });
      try {
        const records: McpbBundle['files'] = [];
        for (const [name, bytes] of bundle.files) {
          const target = join(destination, ...name.split('/'));
          await assertNoLinks(target, true);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await assertNoLinks(dirname(target));
          const handle = await open(target, 'wx', 0o600);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          records.push({
            path: name,
            size: bytes.length,
            sha256: hashBytes(bytes),
          });
        }
        return McpbBundleSchema.parse({
          id,
          archiveHash: bundle.archiveHash,
          files: records,
        });
      } catch {
        try {
          await this.remove(id);
        } catch {
          throw new McpbExtractionFault(false);
        }
        throw new McpbExtractionFault(true);
      }
    },
    async remove(id) {
      const destination = path(id);
      await assertNoLinks(destination, true);
      await rm(destination, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 100,
      });
    },
    async prepare(connector) {
      if (!connector.bundle) throw invalid();
      const bundle = McpbBundleSchema.parse(connector.bundle),
        destination = path(bundle.id);
      const expected = new Map(bundle.files.map((file) => [file.path, file]));
      let total = 0,
        count = 0;
      const visit = async (base: string, prefix = '') => {
        await assertNoLinks(base);
        for (const entry of await readdir(base, { withFileTypes: true })) {
          if (++count > MCPB_MAX_FILES) throw invalid();
          const name = prefix + entry.name,
            target = join(base, entry.name);
          await assertNoLinks(target);
          const info = await lstat(target);
          if (info.isDirectory()) {
            if (
              ![...expected.keys()].some((path) => path.startsWith(name + '/'))
            )
              throw invalid();
            await visit(target, name + '/');
          } else {
            const record = expected.get(name);
            if (
              !record ||
              !info.isFile() ||
              info.nlink !== 1 ||
              info.size !== record.size ||
              (total += info.size) > MCPB_MAX_UNCOMPRESSED_BYTES
            )
              throw invalid();
            const handle = await open(target, 'r'),
              buffer = Buffer.alloc(64 * 1024);
            try {
              const opened = await handle.stat();
              if (
                !opened.isFile() ||
                opened.nlink !== 1 ||
                opened.size !== record.size ||
                opened.ino !== info.ino ||
                opened.dev !== info.dev
              )
                throw invalid();
              const hash = createHash('sha256');
              let bytes = 0;
              for (;;) {
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.length, record.size - bytes + 1),
                  null,
                );
                if (!bytesRead) break;
                bytes += bytesRead;
                if (bytes > record.size) throw invalid();
                hash.update(buffer.subarray(0, bytesRead));
              }
              if (bytes !== record.size || hash.digest('hex') !== record.sha256)
                throw invalid();
            } finally {
              buffer.fill(0);
              await handle.close();
            }
            expected.delete(name);
          }
        }
      };
      await visit(destination);
      if (expected.size) throw invalid();
      return {
        executable: connector.executable,
        arguments: [...connector.arguments],
        environment: {},
        workingDirectory: destination,
      };
    },
  };
}

export function resolveMcpbConfiguration(
  bundle: InspectedMcpb,
  root: string,
  configuration: Record<string, string | number | boolean>,
) {
  const fields =
      bundle.manifest.user_config ?? bundle.manifest.configuration ?? {},
    values: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
  if (Object.keys(configuration).some((key) => !Object.hasOwn(fields, key)))
    throw invalid();
  for (const [key, field] of Object.entries(fields)) {
    const value = configuration[key] ?? field.default;
    if (value === undefined || value === '') {
      if (field.required) throw invalid();
      values[key] = '';
      continue;
    }
    if (
      typeof value !==
        (field.type === 'number'
          ? 'number'
          : field.type === 'boolean'
            ? 'boolean'
            : 'string') ||
      (typeof value === 'number' &&
        (!Number.isFinite(value) ||
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max)))
    )
      throw invalid();
    if (
      (field.type === 'directory' || field.type === 'file') &&
      !/^[a-z]:[\\/][^\0\r\n]*$/i.test(String(value))
    )
      throw invalid();
    values[key] = String(value);
  }
  const render = (template: string) =>
    template.replace(
      /\$\{(__dirname|user_config\.([a-zA-Z][a-zA-Z0-9_]*))\}/g,
      (_match: string, token: string, key: string) =>
        token === '__dirname' ? root : values[key]!,
    );
  const args = (bundle.manifest.server.mcp_config.args ?? []).map(render);
  const environment: Record<string, Buffer> = {};
  try {
    for (const [key, value] of Object.entries(
      bundle.manifest.server.mcp_config.env ?? {},
    )) {
      const rendered = render(value);
      if (rendered) environment[key] = Buffer.from(rendered);
    }
    return {
      arguments:
        bundle.manifest.server.type === 'python'
          ? ['-E', '-s', '-B', ...args]
          : args,
      environment,
    };
  } catch (error) {
    for (const bytes of Object.values(environment)) bytes.fill(0);
    throw error;
  } finally {
    for (const key of Object.keys(values)) values[key] = '';
  }
}

export async function localMcpbAdapter(directory: string) {
  let python: string | undefined;
  try {
    const [candidate] = await createWindowsDiscoveryPorts({
      workingDirectory: directory,
      environment: process.env,
    }).find(['python'], AbortSignal.timeout(3000));
    python =
      candidate?.toLowerCase().endsWith('.exe') &&
      !/WindowsApps/i.test(candidate)
        ? candidate
        : undefined;
  } catch {
    /* Python stays unavailable; other bundle runtimes are independent. */
  }
  return createMcpbAdapter(directory, {
    node: process.execPath,
    ...(python ? { python } : {}),
    async protect(path) {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows',
        executable = win32.join(
          systemRoot,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        );
      const runner = await createWindowsProcessRunner({
        workingDirectory: path,
        allowedExecutables: [executable],
      });
      const result = await runner.run({
        executable,
        arguments: [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          fileURLToPath(new URL('./secrets/dpapi.ps1', import.meta.url)),
        ],
        environment: { PSModulePath: systemModulePath(systemRoot) },
        stdin: JSON.stringify({ action: 'acl', path }),
        signal: AbortSignal.timeout(10_000),
        timeoutMs: 10_000,
        outputLimitBytes: 64 * 1024,
      });
      if (
        result.outcome !== 'exited' ||
        result.exitCode !== 0 ||
        result.stdout !== 'ok'
      )
        throw new HubError('unavailable', 'Bundle cache protection failed.');
    },
  });
}
