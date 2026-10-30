import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export async function buildLauncher(root, { testRegistry = false } = {}) {
  if (process.platform !== 'win32')
    throw new Error('Windows launcher compilation requires Windows.');
  const compiler = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  const source = join(root, 'scripts', 'WaleedMcpHub.cs'),
    temporary = join(root, `launcher-${randomUUID()}.exe`),
    target = join(root, 'WaleedMcpHub.exe');
  try {
    await promisify(execFile)(
      compiler,
      [
        '/nologo',
        '/target:winexe',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll',
        ...(testRegistry ? ['/define:HUB_STARTUP_TEST'] : []),
        `/out:${temporary}`,
        source,
      ],
      { windowsHide: true, timeout: 30000 },
    );
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    await rename(temporary, target);
    await writeFile(
      join(root, 'WaleedMcpHub.launcher.json'),
      JSON.stringify({
        protocol: 'wmh-launcher-v1',
        sha256: hash(await readFile(target)),
        sourceSha256: hash(await readFile(source)),
      }),
    );
    return target;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await buildLauncher(fileURLToPath(new URL('../', import.meta.url)));
  console.info(
    'Built the reviewed Hub launcher. No startup entry was installed.',
  );
}
