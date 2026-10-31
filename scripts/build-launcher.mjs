import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function buildLauncher(root) {
  const target = join(root, 'WaleedMcpHub.exe');
  await promisify(execFile)(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    ),
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/reference:System.Windows.Forms.dll',
      `/out:${target}`,
      join(root, 'scripts', 'WaleedMcpHub.cs'),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await buildLauncher(fileURLToPath(new URL('../', import.meta.url)));
