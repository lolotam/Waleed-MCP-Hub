// Build one offline, per-user Windows installer from the production-only package.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { output as portable } from './package-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = `${portable}-setup`;
await mkdir(output);
const archive = join(output, 'payload.zip');
const constants = join(output, 'Payload.cs');
const target = join(output, 'Waleed-MCP-Hub-Setup.exe');
const system = process.env.SystemRoot ?? 'C:\\Windows';
const exec = promisify(execFile);
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
await exec(
  join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'scripts/compress-desktop.ps1'),
    '-Source',
    portable,
    '-Destination',
    archive,
  ],
  { windowsHide: true, timeout: 300000 },
);
const { version } = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const { stdout: sourceRevision } = await exec('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  windowsHide: true,
});
const payloadHash = await sha256(archive);
await writeFile(
  constants,
  `namespace WaleedMcpHub { internal static class Payload { internal const string Version = ${JSON.stringify(version)}; internal const string Sha256 = "${payloadHash}"; } }\n`,
);
await exec(
  join(system, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    `/resource:${archive},wmh-payload.zip`,
    `/out:${target}`,
    join(root, 'scripts/WaleedMcpHubSetup.cs'),
    constants,
  ],
  { windowsHide: true, timeout: 120000 },
);
await writeFile(
  join(output, 'SHA256SUMS.txt'),
  `${await sha256(target)}  Waleed-MCP-Hub-Setup.exe\n`,
);
await writeFile(
  join(output, 'release.json'),
  JSON.stringify(
    {
      version,
      sourceRevision: sourceRevision.trim(),
      node: process.versions.node,
      architecture: 'win32-x64',
      payloadSha256: payloadHash,
      portableDirectory: portable,
      installer: target,
    },
    null,
    2,
  ) + '\n',
);
await unlink(archive);
await unlink(constants);
console.info(`Single-file installer created: ${target}`);
console.info(`Checksums: ${join(dirname(target), 'SHA256SUMS.txt')}`);
