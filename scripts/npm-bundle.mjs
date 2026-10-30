// Builds and verifies vendor/npm-12.2.1-patched.tgz: the official npm 12.2.1
// tarball with its bundled undici and ip-address replaced by the first releases
// that fix their open advisories. Bundled dependencies cannot be overridden or
// audit-fixed, and no npm release bundles the fixed versions yet, so the hub
// ships this recomposed tarball. Every input is pinned by sha512; `verify`
// proves the vendored file holds exactly the official npm files plus the two
// official replacement packages, and nothing else.
//
//   node scripts/npm-bundle.mjs build    write the vendored tarball
//   node scripts/npm-bundle.mjs verify   check the vendored tarball (CI)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'vendor', 'npm-12.2.1-patched.tgz');
const registry = 'https://registry.npmjs.org';
const npmSource = {
  name: 'npm',
  version: '12.2.1',
  integrity:
    'sha512-bKCmFRVT/BB+YPEYbZwQ1XUI3N5t4xKSpU1MxOjo7z3iWzKBJ0ZXRC1xFdEN+TC7N5TdywaBzf2dMXGJq/e2PQ==',
};
// GHSA-4qv8-2p9j-2685, GHSA-xjj6-f33q-929c, GHSA-2m5v-pch6-74hx,
// GHSA-qrxm-fqhp-jwvm, GHSA-9fm3-97px-rjf6 (undici <= 6.29.0) and
// GHSA-rxp7-6hxx-x8q5 (ip-address <= 10.7.3).
const replacements = [
  {
    name: 'undici',
    version: '6.29.1',
    integrity:
      'sha512-EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA==',
  },
  {
    name: 'ip-address',
    version: '10.7.4',
    integrity:
      'sha512-DWBMKyeM25D70nrIiTkgQth59/G+naKOTep6huF9j+GmeK3DMD60Zvxg5d5qQnz+38AHgou6ean2LECX+lrKDg==',
  },
];
// The fixed timestamp npm itself writes into published tarballs.
const MTIME = 499162500;
const BLOCK = 512;

const sha512 = (buffer) =>
  `sha512-${createHash('sha512').update(buffer).digest('base64')}`;

async function download({ name, version, integrity }) {
  const url = `${registry}/${name}/-/${name}-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (sha512(buffer) !== integrity)
    throw new Error(`${name}@${version}: integrity mismatch`);
  return buffer;
}

const field = (block, offset, length) => {
  const end = block.indexOf(0, offset);
  return block
    .subarray(offset, end < 0 || end > offset + length ? offset + length : end)
    .toString('utf8');
};
const octal = (block, offset, length) =>
  parseInt(field(block, offset, length).trim() || '0', 8);

function paxRecords(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = parseInt(data.subarray(offset, space).toString(), 10);
    if (!(length > 0)) throw new Error('Malformed pax header');
    const record = data.subarray(space + 1, offset + length - 1).toString();
    const equals = record.indexOf('=');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

// Pax keys that only describe metadata this reader does not use. Any other key
// (size, linkpath, ...) would change how another tar reader sees the entry.
const cosmeticPaxKeys = new Set([
  'mtime',
  'atime',
  'ctime',
  'uid',
  'gid',
  'uname',
  'gname',
]);

// Reads regular files and directories of a single plain ustar stream. Links,
// devices, global or GNU headers, bad checksums and data after the end marker
// are refused, so nothing is read differently from how node-tar would read it.
function readTarball(gzipped) {
  const tar = gunzipSync(gzipped);
  const entries = new Map();
  let override = {};
  for (let offset = 0; ;) {
    if (offset + BLOCK > tar.length) throw new Error('Truncated tarball');
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0))
        throw new Error('Data after the tar end marker');
      return entries;
    }
    const unsigned = Buffer.from(header).fill(0x20, 148, 156);
    if (
      unsigned.reduce((total, byte) => total + byte, 0) !==
      octal(header, 148, 8)
    )
      throw new Error('Bad tar header checksum');
    if (field(header, 257, 6) !== 'ustar')
      throw new Error('Not a ustar header');
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const data = Buffer.from(
      tar.subarray(offset + BLOCK, offset + BLOCK + size),
    );
    if (data.length !== size) throw new Error('Truncated tar entry');
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      override = paxRecords(data);
      for (const key of Object.keys(override))
        if (key !== 'path' && !cosmeticPaxKeys.has(key))
          throw new Error(`Unsupported pax key ${key}`);
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const path = override.path ?? (prefix ? `${prefix}/${name}` : name);
    override = {};
    if (type !== '0' && type !== '5')
      throw new Error(`Unsupported tar entry type ${type} at ${path}`);
    if (path.split('/').some((part) => part === '..') || path.startsWith('/'))
      throw new Error(`Unsafe tar path ${path}`);
    const key = type === '5' ? path.replace(/\/?$/, '/') : path;
    if (entries.has(key)) throw new Error(`Duplicate tar entry ${key}`);
    entries.set(key, {
      type,
      mode: octal(header, 100, 8) & 0o777,
      data: type === '5' ? Buffer.alloc(0) : data,
    });
  }
}

function writeOctal(block, offset, length, value) {
  block.write(
    value.toString(8).padStart(length - 1, '0') + '\0',
    offset,
    'ascii',
  );
}

function header(name, prefix, size, mode, type) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 'utf8');
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, MTIME);
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write(prefix, 345, 'utf8');
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

const padded = (data) =>
  Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);

// Splits a path into the ustar prefix/name fields, or returns null when only a
// pax header can carry it.
function ustarPath(path) {
  if (!/^[\x20-\x7e]*$/.test(path)) return null;
  if (path.length <= 100) return { prefix: '', name: path };
  for (
    let index = path.indexOf('/');
    index >= 0;
    index = path.indexOf('/', index + 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (prefix.length <= 155 && name.length <= 100 && name)
      return { prefix, name };
  }
  return null;
}

function paxHeader(path) {
  const body = ` path=${path}\n`;
  let length = Buffer.byteLength(body);
  // The length of a pax record counts its own digits, so both sides are
  // measured in bytes: a path outside the ASCII range is longer in bytes
  // than in characters.
  while (Buffer.byteLength(`${length}${body}`) !== length)
    length = Buffer.byteLength(`${length}${body}`);
  const record = Buffer.from(`${length}${body}`, 'utf8');
  return [header('PaxHeader', '', record.length, 0o644, 'x'), padded(record)];
}

// The uncompressed tar stream; deterministic for a given set of entries.
function tarStream(entries) {
  const blocks = [];
  for (const path of [...entries.keys()].sort()) {
    const entry = entries.get(path);
    const split = ustarPath(path);
    if (!split) blocks.push(...paxHeader(path));
    const { prefix, name } = split ?? { prefix: '', name: 'pax-path' };
    blocks.push(
      header(name, prefix, entry.data.length, entry.mode, entry.type),
    );
    blocks.push(padded(entry.data));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

// The official npm files, minus the two bundled packages, plus the official
// replacement packages under the same folders.
async function expectedEntries() {
  const entries = readTarball(await download(npmSource));
  for (const replacement of replacements) {
    const folder = `package/node_modules/${replacement.name}/`;
    if (![...entries.keys()].some((path) => path.startsWith(folder)))
      throw new Error(`npm does not bundle ${replacement.name}`);
    for (const path of [...entries.keys()])
      if (path.startsWith(folder)) entries.delete(path);
    const source = readTarball(await download(replacement));
    for (const [path, entry] of source) {
      if (!path.startsWith('package/'))
        throw new Error(`${replacement.name}: entry outside package/`);
      entries.set(folder + path.slice('package/'.length), entry);
    }
  }
  return entries;
}

// The length of the header of the gzip member at the start of a buffer, or
// null when it is not a deflate member (RFC 1952, section 2.3).
function gzipHeaderLength(bytes) {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
  if (bytes[2] !== 8) return null;
  const flags = bytes[3];
  let offset = 10;
  if (flags & 4) offset += 2 + bytes.readUInt16LE(offset);
  for (const flag of [8, 16]) {
    if (!(flags & flag)) continue;
    const end = bytes.indexOf(0, offset);
    if (end < 0) return null;
    offset = end + 1;
  }
  if (flags & 2) offset += 2;
  return offset < bytes.length ? offset : null;
}

// The vendored file must decompress to exactly the expected tar stream, as one
// gzip member with nothing after it. The deflate stream of the first member
// must end eight bytes before the file does, which rules out a second member
// before or after it and any trailing bytes; the trailer's CRC32 and size
// then cover the whole stream.
function verifyBundle(vendored, expected) {
  let actual;
  try {
    actual = gunzipSync(vendored);
  } catch {
    return 'the vendored file is not valid gzip';
  }
  if (!actual.equals(expected))
    return 'the vendored contents differ from the official composition';
  const header = gzipHeaderLength(vendored);
  if (header === null) return 'the vendored file is not a single gzip member';
  let consumed;
  try {
    consumed = inflateRawSync(vendored.subarray(header), { info: true }).engine
      .bytesWritten;
  } catch {
    return 'the vendored file is not a single gzip member';
  }
  const trailer = vendored.length - 8;
  if (
    header + consumed !== trailer ||
    vendored.readUInt32LE(trailer) !== crc32(expected) ||
    vendored.readUInt32LE(trailer + 4) !== expected.length % 2 ** 32
  )
    return 'the vendored file is not a single gzip member';
  return null;
}

const command = process.argv[2];
if (command === 'build') {
  const tarball = gzipSync(tarStream(await expectedEntries()), { level: 9 });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, tarball);
  console.log(`Wrote ${output} (${sha512(tarball)}).`);
} else if (command === 'verify') {
  const problem = verifyBundle(
    await readFile(output),
    tarStream(await expectedEntries()),
  );
  if (problem) {
    console.error(`npm bundle verification failed: ${problem}.`);
    process.exit(1);
  }
  console.log(
    `npm bundle verified: npm ${npmSource.version} with ${replacements
      .map(({ name, version }) => `${name} ${version}`)
      .join(', ')}.`,
  );
} else {
  console.error('Usage: node scripts/npm-bundle.mjs build|verify');
  process.exit(2);
}
