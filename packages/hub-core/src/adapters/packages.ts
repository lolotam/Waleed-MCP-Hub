import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
  win32,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PackageSpecSchema,
  type Connector,
  type PackageSpec,
} from '@waleed/contracts';
import type { ProcessRunner } from '../ports.js';
import { approved, hashData } from '../runtime/registry.js';
import { RuntimeFault } from '../runtime/capabilities.js';
import { assertNoLinks } from './managed-files.js';
import { runtimePackageDirectory } from '../platform/paths.js';
import { createWindowsDiscoveryPorts } from './discovery-files.js';
import {
  createWindowsProcessRunner,
  systemModulePath,
} from './native/process-runner.js';

type PackageConnector = Extract<Connector, { executionMode: 'package' }>;
export interface PackageLaunch {
  executable: string;
  arguments: string[];
  environment: Record<string, string>;
  workingDirectory: string;
}
export interface PackageTools {
  node: string;
  npmCli?: string;
  uv?: string;
  runner(directory: string, executables: string[]): Promise<ProcessRunner>;
  protect(directory: string, signal: AbortSignal): Promise<void>;
}
const fault = () => new RuntimeFault('adapter_pending');
const within = (root: string, path: string) => {
  const part = relative(root, path);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw fault();
  return part;
};
const safeText = async (path: string, limit = 1024 * 1024) => {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw fault();
  return readFile(path, 'utf8');
};
const safeJson = async (path: string, limit = 1024 * 1024) =>
  JSON.parse(await safeText(path, limit)) as unknown;
export function packageArguments(connector: PackageConnector) {
  const args = [...connector.arguments];
  if (
    args.length > 128 ||
    args.some((arg) => arg.length > 4096 || /[\0\r\n]/.test(arg))
  )
    throw fault();
  if (
    connector.package.manager === 'npm' &&
    connector.package.name === 'chrome-devtools-mcp'
  ) {
    if (
      args.some((arg) =>
        /^--(?:browser-url|browserURL|autoConnect|auto-connect|user-data-dir|userDataDir)(?:=|$)/i.test(
          arg,
        ),
      )
    )
      throw fault();
    if (!args.includes('--isolated')) args.push('--isolated');
  }
  return args;
}
async function manifest(root: string, signal: AbortSignal) {
  const files: Record<string, string> = {};
  let total = 0,
    count = 0;
  async function visit(directory: string, depth = 0) {
    if (depth > 32) throw fault();
    for (const name of (await readdir(directory)).sort()) {
      signal.throwIfAborted();
      if (directory === root && name === 'receipt.json') continue;
      if (++count > 25_000) throw fault();
      const path = join(directory, name),
        info = await lstat(path);
      if (info.isSymbolicLink() || (info.nlink !== 1 && !info.isDirectory()))
        throw fault();
      if (info.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!info.isFile() || (total += info.size) > 512 * 1024 * 1024)
        throw fault();
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path, { signal }))
        hash.update(chunk);
      files[relative(root, path)] = hash.digest('hex');
    }
  }
  await visit(root);
  return files;
}
function installEnvironment(root: string, node: string) {
  return {
    PATH: [
      dirname(node),
      win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
    ].join(sep === '\\' ? ';' : ':'),
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'home'),
    LOCALAPPDATA: join(root, 'home'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    UV_CACHE_DIR: join(root, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(root, 'python'),
    UV_TOOL_DIR: join(root, 'uv-tools'),
    UV_TOOL_BIN_DIR: join(root, 'uv-bin'),
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
    UV_LINK_MODE: 'copy',
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PIP_CONFIG_FILE: 'NUL',
    NPM_CONFIG_USERCONFIG: join(root, 'empty.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'empty-global.npmrc'),
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}
async function npmEntry(directory: string, spec: PackageSpec) {
  const root = join(directory, 'node_modules', ...spec.name.split('/'));
  const pkg = (await safeJson(join(root, 'package.json'))) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (pkg.name !== spec.name || pkg.version !== spec.version) throw fault();
  const bin =
    typeof pkg.bin === 'string'
      ? spec.entryPoint === spec.name.split('/').at(-1)
        ? pkg.bin
        : undefined
      : pkg.bin?.[spec.entryPoint];
  if (
    typeof bin !== 'string' ||
    isAbsolute(bin) ||
    /^[a-z]:|[\0\r\n]/i.test(bin)
  )
    throw fault();
  const path = join(root, bin);
  within(root, path);
  await assertNoLinks(path);
  if (!['.js', '.mjs', '.cjs', ''].includes(extname(path).toLowerCase()))
    throw fault();
  if (!(await lstat(path)).isFile()) throw fault();
  return path;
}
async function pythonEntry(directory: string, spec: PackageSpec) {
  const site = join(directory, 'venv', 'Lib', 'site-packages');
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[._-]+/g, '-');
  let found = false;
  for (const name of await readdir(site)) {
    if (!name.endsWith('.dist-info')) continue;
    const dir = join(site, name);
    await assertNoLinks(dir);
    const metadata = await safeText(join(dir, 'METADATA'));
    if (
      normalize(/^Name: (.+)$/m.exec(metadata)?.[1] ?? '') !==
      normalize(spec.name)
    )
      continue;
    if (/^Version: (.+)$/m.exec(metadata)?.[1] !== spec.version) throw fault();
    const points = await safeText(join(dir, 'entry_points.txt'));
    let consoleScripts = false;
    for (const line of points.split(/\r?\n/)) {
      if (/^\[/.test(line))
        consoleScripts = line.trim() === '[console_scripts]';
      else if (consoleScripts && line.split('=')[0]?.trim() === spec.entryPoint)
        found = true;
    }
  }
  if (!found) throw fault();
  const exe = join(directory, 'venv', 'Scripts', `${spec.entryPoint}.exe`);
  await assertNoLinks(exe);
  if (!(await lstat(exe)).isFile()) throw fault();
  return exe;
}

// Install commands never receive connector credentials. Only the prepared launch
// descriptor crosses back to the bridge, which leases secrets after preparation.
export function createPackageRuntime(directory: string, tools: PackageTools) {
  const root = runtimePackageDirectory(directory);
  return {
    async prepare(
      connector: PackageConnector,
      signal: AbortSignal,
      install = false,
    ): Promise<PackageLaunch> {
      signal.throwIfAborted();
      if (
        !connector.enabled ||
        !approved(connector) ||
        Object.keys(connector.headerBindings).length
      )
        throw fault();
      const spec = PackageSpecSchema.parse(connector.package),
        args = packageArguments(connector);
      const key = hashData([
        spec,
        process.platform,
        process.arch,
        process.version,
        tools.node,
      ]);
      const destination = join(root, key);
      const describe = async () => {
        await assertNoLinks(destination);
        const receipt = (await safeJson(
          join(destination, 'receipt.json'),
          4 * 1024 * 1024,
        )) as {
          version?: number;
          key?: string;
          files?: Record<string, string>;
        };
        if (
          receipt.version !== 1 ||
          receipt.key !== key ||
          hashData(receipt.files) !==
            hashData(await manifest(destination, signal))
        )
          throw fault();
        const entry =
          spec.manager === 'npm'
            ? await npmEntry(destination, spec)
            : await pythonEntry(destination, spec);
        return {
          executable: spec.manager === 'npm' ? tools.node : entry,
          arguments: spec.manager === 'npm' ? [entry, ...args] : args,
          environment: installEnvironment(root, tools.node),
          workingDirectory: join(root, 'home'),
        };
      };
      try {
        await lstat(destination);
        return await describe();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!install) throw fault();
      await assertNoLinks(root, true);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await tools.protect(root, signal);
      await assertNoLinks(root);
      const lockPath = join(root, `${key}.lock`);
      const lock = await open(lockPath, 'wx', 0o600).catch(() => {
        throw fault();
      });
      // Windows venv launchers embed their absolute installation path.
      const stage =
        spec.manager === 'uvx'
          ? destination
          : join(root, `stage-${randomUUID()}`);
      let published = false,
        created = false;
      try {
        await lock.writeFile(JSON.stringify({ key }));
        // A racing client may have published before this lock was acquired.
        try {
          await lstat(destination);
          return await describe();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await mkdir(stage, { mode: 0o700 });
        created = true;
        for (const name of ['home', 'tmp'])
          await mkdir(join(root, name), { recursive: true, mode: 0o700 });
        for (const name of ['empty.npmrc', 'empty-global.npmrc']) {
          const path = join(root, name);
          await assertNoLinks(path, true);
          try {
            const file = await open(path, 'wx', 0o600);
            await file.close();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const info = await lstat(path);
            if (!info.isFile() || info.nlink !== 1 || info.size !== 0)
              throw fault();
          }
        }
        const environment = installEnvironment(root, tools.node);
        const execute = async (executable: string, argv: string[]) => {
          signal.throwIfAborted();
          const runner = await tools.runner(stage, [executable]);
          const result = await runner.run({
            executable,
            arguments: argv,
            environment,
            signal,
            timeoutMs: 120_000,
            outputLimitBytes: 1024 * 1024,
          });
          if (result.outcome !== 'exited' || result.exitCode !== 0)
            throw new RuntimeFault(
              signal.aborted ? 'cancelled' : 'dependency_unavailable',
            );
        };
        if (spec.manager === 'npm') {
          if (!tools.npmCli) throw fault();
          await assertNoLinks(tools.npmCli);
          await writeFile(
            join(stage, 'package.json'),
            JSON.stringify({
              private: true,
              name: 'wmh-managed-install',
              version: '1.0.0',
            }),
          );
          await execute(tools.node, [
            tools.npmCli,
            'install',
            '--prefix',
            stage,
            '--save-exact',
            '--ignore-scripts',
            '--omit=dev',
            '--no-audit',
            '--no-fund',
            '--bin-links=false',
            '--workspaces=false',
            '--registry=https://registry.npmjs.org/',
            `${spec.name}@${spec.version}`,
          ]);
          await npmEntry(stage, spec);
        } else {
          if (!tools.uv) throw fault();
          await execute(tools.uv, [
            'venv',
            '--no-config',
            '--no-project',
            '--managed-python',
            '--python',
            '3.13',
            join(stage, 'venv'),
          ]);
          await execute(tools.uv, [
            'pip',
            'install',
            '--no-config',
            '--python',
            join(stage, 'venv', 'Scripts', 'python.exe'),
            '--only-binary',
            ':all:',
            '--default-index',
            'https://pypi.org/simple',
            `${spec.name}==${spec.version}`,
          ]);
          await pythonEntry(stage, spec);
        }
        signal.throwIfAborted();
        const receipt = JSON.stringify({
          version: 1,
          key,
          files: await manifest(stage, signal),
        });
        if (Buffer.byteLength(receipt) > 4 * 1024 * 1024) throw fault();
        await writeFile(join(stage, 'receipt.pending'), receipt, {
          flag: 'wx',
          mode: 0o600,
        });
        signal.throwIfAborted();
        await rename(
          join(stage, 'receipt.pending'),
          join(stage, 'receipt.json'),
        );
        if (stage !== destination) await rename(stage, destination);
        published = true;
        return await describe();
      } finally {
        try {
          if (created && !published)
            await rm(stage, {
              recursive: true,
              force: true,
              maxRetries: 4,
              retryDelay: 100,
            });
        } finally {
          await lock.close();
        }
        await unlink(lockPath);
      }
    },
  };
}

export async function localPackageRuntime(directory: string) {
  // Platform-native installer/venv validation is not part of readiness. Do not
  // try a Windows installer or weaken receipt/symlink checks on a POSIX host.
  if (process.platform !== 'win32') throw fault();
  const discovery = createWindowsDiscoveryPorts({
    workingDirectory: directory,
    environment: process.env,
  });
  const [npm] = await discovery.find(['npm'], AbortSignal.timeout(3000));
  const [uv] = await discovery.find(['uv'], AbortSignal.timeout(3000));
  let npmCli: string | undefined;
  for (const base of [
    dirname(process.execPath),
    ...(npm ? [dirname(npm)] : []),
  ]) {
    const candidate = join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    try {
      await assertNoLinks(candidate);
      if ((await lstat(candidate)).isFile()) {
        npmCli = await realpath(candidate);
        break;
      }
    } catch {
      /* Missing tooling remains unavailable, never invoke a shim. */
    }
  }
  return createPackageRuntime(directory, {
    node: process.execPath,
    ...(npmCli ? { npmCli } : {}),
    ...(uv ? { uv } : {}),
    runner: async (workingDirectory, allowedExecutables) =>
      createWindowsProcessRunner({
        workingDirectory,
        allowedExecutables,
        concurrency: 1,
      }),
    async protect(path, signal) {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      const executable = win32.join(
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
        signal,
        timeoutMs: 10_000,
        outputLimitBytes: 64 * 1024,
      });
      if (
        result.outcome !== 'exited' ||
        result.exitCode !== 0 ||
        result.stdout !== 'ok'
      )
        throw fault();
    },
  });
}
