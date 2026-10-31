// Exercise the actual EXE in a disposable directory with no Node/npm on PATH.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  appendFile,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass Waleed-MCP-Hub-Setup.exe.');
const temporary = await mkdtemp(join(tmpdir(), 'wmh-installer-'));
const destination = join(temporary, 'Installed App تجربة');
const exec = promisify(execFile);
const env = { ...process.env, PATH: '' };
const flags = ['--silent', '--no-launch', '--no-shortcuts'];
const install = (file = installer, directory = destination) =>
  exec(file, [...flags, '--directory', directory], {
    env,
    windowsHide: true,
    timeout: 180000,
  });

await install();
let folders = await readdir(destination);
assert.equal(folders.length, 1);
const app = join(destination, folders[0]);
await exec(join(app, 'WaleedMcpHub.exe'), ['--self-test'], {
  env,
  windowsHide: true,
  timeout: 30000,
});
await exec(
  process.execPath,
  [
    fileURLToPath(new URL('./verify-desktop-package.mjs', import.meta.url)),
    app,
  ],
  { windowsHide: true, timeout: 120000 },
);
await install();
assert.deepEqual(
  await readdir(destination),
  folders,
  'A second install reuses the verified build.',
);
await appendFile(
  join(app, 'WaleedMcpHub.exe'),
  'installer-repair-verification',
);
await install();
folders = await readdir(destination);
assert.equal(
  folders.length,
  2,
  'Repair publishes a fresh build without overwriting a running installation.',
);
assert.ok(folders.some((name) => name.includes('-repair-')));
assert.ok(
  (await readFile(join(app, 'WaleedMcpHub.exe'))).includes(
    Buffer.from('installer-repair-verification'),
  ),
);
const modified = Buffer.from(await readFile(installer));
const zipOffset = modified.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
assert.ok(zipOffset > 0, 'Installer contains its application archive.');
modified[zipOffset + 30] ^= 1;
const damaged = join(temporary, 'damaged-setup.exe');
await writeFile(damaged, modified);
const rejected = join(temporary, 'must-not-install');
await assert.rejects(install(damaged, rejected), (error) => error.code === 1);
const contents = await readdir(rejected).catch(() => []);
assert.deepEqual(
  contents,
  [],
  'A corrupt payload never publishes an installation.',
);
await assert.rejects(lstat(join(app, 'state.json')), { code: 'ENOENT' });
console.info(
  'Installer verified: offline extraction, bundled launcher/runtime, fresh-profile authenticated backend, idempotent reinstall, non-destructive repair, corrupt-payload rejection, paths with spaces/Unicode, and empty PATH.',
);
console.info(`Disposable verification files retained at: ${temporary}`);
