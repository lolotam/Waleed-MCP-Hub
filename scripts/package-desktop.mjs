// Offline portable-folder packaging from the installed, exact-locked workspace.
// No npm install, lifecycle hooks, personal configs, vaults, or pilot files copied.
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildLauncher } from './build-launcher.mjs';
import { writeDesktopIntegrity } from './desktop-integrity.mjs';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error('Package using Node 24 on Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
await access(join(root, 'apps/server/dist/main.js'));
await access(join(root, 'apps/web/dist/index.html'));
const output = join(
  root,
  'desktop-builds',
  `Waleed-MCP-Hub-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
);
await mkdir(output, { recursive: true });
const queue = [join(root, 'apps/server/package.json')],
  seen = new Set();
async function packageFor(name, from) {
  const require = createRequire(from);
  let entry;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch {
    entry = require.resolve(name);
  }
  let current = dirname(entry);
  return (async () => {
    for (let i = 0; i < 15; i++) {
      const candidate = join(current, 'package.json');
      try {
        if (JSON.parse(await readFile(candidate, 'utf8')).name === name)
          return candidate;
      } catch {
        /* Continue toward the package root; never copy arbitrary parents. */
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    throw new Error('Cannot resolve a production package safely.');
  })();
}
while (queue.length) {
  const manifest = await queue.shift();
  if (seen.has(manifest)) continue;
  seen.add(manifest);
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  const source = dirname(manifest);
  const workspace = pkg.name?.startsWith('@waleed/');
  const destination = workspace
    ? join(output, 'node_modules', pkg.name)
    : join(output, relative(root, source));
  if (!workspace && relative(root, source).startsWith('..'))
    throw new Error('External production package is not copied.');
  if (workspace) {
    await mkdir(destination, { recursive: true });
    await cp(join(source, 'dist'), join(destination, 'dist'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await cp(manifest, join(destination, 'package.json'));
  } else
    await cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: true,
      filter: (path) => relative(source, path).split(sep)[0] !== 'node_modules',
    });
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  })) {
    try {
      queue.push(await packageFor(name, manifest));
    } catch (error) {
      if (!Object.hasOwn(pkg.optionalDependencies ?? {}, name)) throw error;
    }
  }
}
await mkdir(join(output, 'apps/server'), { recursive: true });
await cp(join(root, 'apps/server/dist'), join(output, 'apps/server/dist'), {
  recursive: true,
});
await cp(
  join(root, 'apps/server/package.json'),
  join(output, 'apps/server/package.json'),
);
await cp(join(root, 'apps/web/dist'), join(output, 'apps/web/dist'), {
  recursive: true,
});
await mkdir(join(output, 'runtime'), { recursive: true });
await cp(process.execPath, join(output, 'runtime/node.exe'));
await cp(
  join(dirname(process.execPath), 'LICENSE'),
  join(output, 'runtime/NODE-LICENSE.txt'),
);
await mkdir(join(output, 'scripts'), { recursive: true });
for (const file of [
  'desktop.mjs',
  'desktop-runtime.mjs',
  'start-desktop.ps1',
  'start-desktop.bat',
  'install-desktop-shortcut.ps1',
  'WaleedMcpHub.cs',
]) {
  await cp(join(root, 'scripts', file), join(output, 'scripts', file));
}
await buildLauncher(output);
await writeFile(
  join(output, 'package.json'),
  JSON.stringify({
    name: 'waleed-mcp-hub-desktop',
    version: '0.1.0',
    private: true,
    type: 'module',
  }),
);
await writeFile(
  join(output, 'README.txt'),
  'Run WaleedMcpHub.exe for the Windows tray, or scripts\\start-desktop.bat. Edge is required. Startup registration is opt-in in Settings and uses only this launcher under HKCU Run. No service or agent configuration is installed by packaging. Tray Exit or Settings > Stop desktop manager shuts down gracefully.\r\n',
);
await writeDesktopIntegrity(output);
console.info(`Portable desktop folder created: ${relative(root, output)}`);
