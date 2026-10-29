import { lstat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { PackageErrorCode } from '@waleed/contracts';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import type { ProcessResult, ProcessRunner } from '../ports.js';
import { PackageFault } from './fault.js';
import { NPM_REGISTRY, startAllowListProxy } from './proxy.js';
import { createPrivateDirectory, jobDirectory } from './store.js';

// The npm that ships with the hub. It is a pinned dependency of this package,
// so it is resolved from the module itself and never from a global install.
const npmRequire = createRequire(import.meta.url);
const npmManifestPath = (): string => npmRequire.resolve('npm/package.json');

export const bundledNpmCli = (): string =>
  join(dirname(npmManifestPath()), 'bin', 'npm-cli.js');

export const bundledNpmVersion = (): string => {
  const manifest = npmRequire('npm/package.json') as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0)
    throw new PackageFault('install_failed');
  return manifest.version;
};

// The registry the hub talks to. Production always uses the npm registry; a
// test injects a loopback target with its own certificate authority. There is
// no environment variable and no setting that changes it.
export interface RegistryTarget {
  host: string;
  port: number;
  origin: string;
  ca?: string;
}
export const DEFAULT_REGISTRY: RegistryTarget = { ...NPM_REGISTRY };

// The paths one npm run needs: the working folder, the cache, the temporary
// folder, the redirected profile folders and the two empty configuration files.
export interface NpmPaths {
  prefix: string;
  cache: string;
  tmp: string;
  home: string;
  appdata: string;
  localappdata: string;
  userNpmrc: string;
  globalNpmrc: string;
  ca: string | null;
}
export interface JobPaths extends NpmPaths {
  root: string;
  project: string;
}

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

// npm looks for a project root in the parent folders and reads the project's
// own configuration there. The hub refuses to start when the data folder sits
// inside an npm project, so no ancestor configuration can reach the install.
export async function assertNoAncestorProject(
  packagesDir: string,
): Promise<void> {
  let current = dirname(resolve(packagesDir));
  for (;;) {
    for (const name of ['package.json', '.npmrc', 'node_modules']) {
      try {
        await lstat(join(current, name));
      } catch (error) {
        const reason = code(error);
        if (reason === 'ENOENT' || reason === 'ENOTDIR') continue;
        // An ancestor that cannot be checked counts as one that is present; a
        // raw error would also carry its path to the caller.
        throw new PackageFault('install_failed');
      }
      throw new PackageFault('install_failed');
    }
    const up = dirname(current);
    if (up === current) return;
    current = up;
  }
}

// The job folder: the staging project, the cache, the temporary folder, the
// redirected profile folders and the two empty configuration files. Everything
// is private to the current user and nothing of it leaves the job.
export async function prepareJob(
  packagesDir: string,
  jobId: string,
  registry: RegistryTarget,
): Promise<JobPaths> {
  const root = jobDirectory(packagesDir, jobId);
  const profile = join(root, 'profile');
  const paths: JobPaths = {
    root,
    project: join(root, 'project'),
    prefix: join(root, 'project'),
    cache: join(root, 'cache'),
    tmp: join(root, 'tmp'),
    home: join(profile, 'home'),
    appdata: join(profile, 'appdata'),
    localappdata: join(profile, 'localappdata'),
    userNpmrc: join(root, 'user.npmrc'),
    globalNpmrc: join(root, 'global.npmrc'),
    ca: registry.ca === undefined ? null : join(root, 'ca.pem'),
  };
  await createPrivateDirectory(root);
  await createPrivateDirectory(paths.project);
  await createPrivateDirectory(paths.cache);
  await createPrivateDirectory(paths.tmp);
  await createPrivateDirectory(profile);
  await createPrivateDirectory(paths.home);
  await createPrivateDirectory(paths.appdata);
  await createPrivateDirectory(paths.localappdata);
  await writeFile(paths.userNpmrc, '', { flag: 'wx', mode: 0o600 });
  await writeFile(paths.globalNpmrc, '', { flag: 'wx', mode: 0o600 });
  if (registry.ca !== undefined && paths.ca)
    await writeFile(paths.ca, registry.ca, { flag: 'wx', mode: 0o600 });
  return paths;
}

// The isolation settings of the spec: no scripts, no workspace, no inherited
// configuration, no fund, no audit, the four allow flags, strict TLS and the
// allow-list proxy.
const LOCK_FLAGS = [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--omit=dev',
  '--omit=optional',
  '--no-audit',
  '--no-fund',
  '--save-exact',
];
const CI_FLAGS = [
  'ci',
  '--ignore-scripts',
  '--omit=dev',
  '--omit=optional',
  '--no-audit',
  '--no-fund',
];

const isolationArguments = (
  paths: NpmPaths,
  registry: RegistryTarget,
  proxyUrl: string,
): string[] => {
  const arguments_ = [
    `--prefix=${paths.prefix}`,
    '--workspaces=false',
    '--include-workspace-root=false',
    `--userconfig=${paths.userNpmrc}`,
    `--globalconfig=${paths.globalNpmrc}`,
    `--cache=${paths.cache}`,
    '--logs-max=0',
    '--update-notifier=false',
    '--fund=false',
    '--audit=false',
    '--allow-directory=none',
    '--allow-file=none',
    '--allow-git=none',
    '--allow-remote=none',
    '--strict-ssl=true',
    `--registry=${registry.origin}/`,
    `--proxy=${proxyUrl}`,
    `--https-proxy=${proxyUrl}`,
    '--noproxy=',
    '--loglevel=error',
    '--progress=false',
    '--color=false',
  ];
  if (registry.ca !== undefined && paths.ca)
    arguments_.push(`--cafile=${paths.ca}`);
  return arguments_;
};

export const npmArguments = (
  command: 'lock' | 'ci',
  paths: NpmPaths,
  registry: RegistryTarget,
  proxyUrl: string,
): string[] => [
  bundledNpmCli(),
  ...(command === 'lock' ? LOCK_FLAGS : CI_FLAGS),
  ...isolationArguments(paths, registry, proxyUrl),
];

// The environment of the npm process: nothing of the user's, no PATH, no
// npm_config_* and no secret. The runner adds SystemRoot and WINDIR.
export const npmEnvironment = (paths: NpmPaths): Record<string, string> => ({
  TEMP: paths.tmp,
  TMP: paths.tmp,
  HOME: paths.home,
  USERPROFILE: paths.home,
  APPDATA: paths.appdata,
  LOCALAPPDATA: paths.localappdata,
});

export interface NpmRunOptions {
  command: 'lock' | 'ci';
  prefix: string;
  paths: NpmPaths;
  registry: RegistryTarget;
  signal: AbortSignal;
  downloadCapBytes: number;
  timeoutMs: number;
  nodeExecutable?: string;
  runner?: ProcessRunner;
}
export interface NpmRunResult {
  outcome: ProcessResult['outcome'];
  exitCode: number | null;
  downloadedBytes: number;
  capExceeded: boolean;
  foreignAttempt: boolean;
}

// The npm output is never returned, logged or kept: only the exit status of
// the run and what the allow-list proxy saw.
export interface NpmExecution {
  result: ProcessResult;
  downloadedBytes: number;
  capExceeded: boolean;
  foreignAttempt: boolean;
}

interface NpmExecutionOptions {
  arguments: (proxyUrl: string) => string[];
  prefix: string;
  paths: NpmPaths;
  registry: RegistryTarget;
  signal: AbortSignal;
  downloadCapBytes: number;
  timeoutMs: number;
  nodeExecutable?: string;
  runner?: ProcessRunner;
}

const executeNpm = async (
  options: NpmExecutionOptions,
): Promise<NpmExecution> => {
  const proxy = await startAllowListProxy({
    allow: [{ host: options.registry.host, port: options.registry.port }],
    downloadCapBytes: options.downloadCapBytes,
  });
  const executable = options.nodeExecutable ?? process.execPath;
  const runner =
    options.runner ??
    (await createWindowsProcessRunner({
      allowedExecutables: [executable],
      workingDirectory: options.prefix,
      concurrency: 1,
      maxTimeoutMs: 600_000,
    }));
  try {
    const result = await runner.run({
      executable,
      arguments: options.arguments(proxy.url),
      environment: npmEnvironment(options.paths),
      timeoutMs: options.timeoutMs,
      outputLimitBytes: 1024 * 1024,
      signal: options.signal,
    });
    const expected =
      `${options.registry.host}:${options.registry.port}`.toLowerCase();
    const foreignAttempt = proxy
      .connections()
      .some((authority) => authority.toLowerCase() !== expected);
    return {
      result,
      downloadedBytes: proxy.downloadedBytes(),
      capExceeded: proxy.capExceeded(),
      foreignAttempt,
    };
  } finally {
    await proxy.close();
  }
};

export const runNpm = async (options: NpmRunOptions): Promise<NpmRunResult> => {
  const paths: NpmPaths = { ...options.paths, prefix: options.prefix };
  const execution = await executeNpm({
    arguments: (proxyUrl) =>
      npmArguments(options.command, paths, options.registry, proxyUrl),
    prefix: options.prefix,
    paths,
    registry: options.registry,
    signal: options.signal,
    downloadCapBytes: options.downloadCapBytes,
    timeoutMs: options.timeoutMs,
    ...(options.nodeExecutable === undefined
      ? {}
      : { nodeExecutable: options.nodeExecutable }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  return {
    outcome: execution.result.outcome,
    exitCode: execution.result.exitCode,
    downloadedBytes: execution.downloadedBytes,
    capExceeded: execution.capExceeded,
    foreignAttempt: execution.foreignAttempt,
  };
};

// The sanitized failure of an npm run. Nothing of the run itself is reported.
export const npmFault = (
  result: NpmRunResult,
  signal: AbortSignal,
): PackageErrorCode | null => {
  if (signal.aborted) return 'cancelled';
  if (result.foreignAttempt) return 'foreign_host';
  if (result.capExceeded) return 'install_limit';
  if (result.outcome === 'exited' && result.exitCode === 0) return null;
  return 'install_failed';
};

export interface NpmSelfTestOptions {
  paths: NpmPaths;
  registry: RegistryTarget;
  signal: AbortSignal;
  nodeExecutable?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  downloadCapBytes?: number;
}

// The startup self-test: the pinned npm is the version the hub expects and it
// understands the four allow flags. A difference fails the start.
export const npmSelfTest = async (
  options: NpmSelfTestOptions,
): Promise<void> => {
  const failed = () => new PackageFault('install_failed');
  const paths = options.paths;
  const run = async (
    arguments_: (proxyUrl: string) => string[],
  ): Promise<string> => {
    const execution = await executeNpm({
      arguments: arguments_,
      prefix: paths.prefix,
      paths,
      registry: options.registry,
      signal: options.signal,
      downloadCapBytes: options.downloadCapBytes ?? 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.nodeExecutable === undefined
        ? {}
        : { nodeExecutable: options.nodeExecutable }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    if (
      execution.result.outcome !== 'exited' ||
      execution.result.exitCode !== 0
    )
      throw failed();
    return execution.result.stdout;
  };

  const version = (
    await run((proxyUrl) => [
      bundledNpmCli(),
      '--version',
      ...isolationArguments(paths, options.registry, proxyUrl),
    ])
  ).trim();
  if (version !== bundledNpmVersion()) throw failed();

  const reported = await run((proxyUrl) => [
    bundledNpmCli(),
    'config',
    'get',
    'allow-directory',
    'allow-file',
    'allow-git',
    'allow-remote',
    ...isolationArguments(paths, options.registry, proxyUrl),
  ]);
  const values = new Map<string, string>();
  for (const line of reported.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  for (const key of [
    'allow-directory',
    'allow-file',
    'allow-git',
    'allow-remote',
  ])
    if (values.get(key) !== 'none') throw failed();
};
