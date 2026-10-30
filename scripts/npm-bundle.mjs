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
import { gunzipSync, gzipSync } from 'node:zlib';

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

// Reads regular files and directories; refuses links and devices so nothing but
// plain package contents can pass through.
function readTarball(gzipped) {
  const tar = gunzipSync(gzipped);
  const entries = new Map();
  let override = {};
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const data = Buffer.from(
      tar.subarray(offset + BLOCK, offset + BLOCK + size),
    );
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      override = paxRecords(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      override = { path: data.toString('utf8').replace(/\0+$/, '') };
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
  return entries;
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
  while (`${length}${body}`.length !== length)
    length = Buffer.byteLength(`${length}${body}`);
  const record = Buffer.from(`${length}${body}`, 'utf8');
  return [header('PaxHeader', '', record.length, 0o644, 'x'), padded(record)];
}

function writeTarball(entries) {
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
  return gzipSync(Buffer.concat(blocks), { level: 9 });
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

function compare(actual, expected) {
  const problems = [];
  for (const [path, entry] of expected) {
    const found = actual.get(path);
    if (!found) problems.push(`missing ${path}`);
    else if (
      found.type !== entry.type ||
      found.mode !== entry.mode ||
      !found.data.equals(entry.data)
    )
      problems.push(`differs ${path}`);
  }
  for (const path of actual.keys())
    if (!expected.has(path)) problems.push(`unexpected ${path}`);
  return problems;
}

const command = process.argv[2];
if (command === 'build') {
  const tarball = writeTarball(await expectedEntries());
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, tarball);
  console.log(`Wrote ${output} (${sha512(tarball)}).`);
} else if (command === 'verify') {
  const problems = compare(
    readTarball(await readFile(output)),
    await expectedEntries(),
  );
  if (problems.length) {
    console.error(problems.slice(0, 50).join('\n'));
    console.error(`npm bundle verification failed (${problems.length}).`);
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
