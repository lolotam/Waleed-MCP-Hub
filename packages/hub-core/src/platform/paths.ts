import { posix, win32 } from 'node:path';
import { HubError } from '../errors.js';

export type HubPlatform = 'win32' | 'darwin' | 'linux';
export function supportedPlatform(platform: string): HubPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux')
    return platform;
  throw new HubError(
    'unavailable',
    'This operating system has no reviewed platform adapter.',
  );
}
export const platformPath = (platform: HubPlatform) =>
  platform === 'win32' ? win32 : posix;
export const runtimePackageDirectory = (
  directory: string,
  platform: HubPlatform = supportedPlatform(process.platform),
) => platformPath(platform).join(directory, 'packages');
export function platformPathKey(path: string, platform: HubPlatform) {
  const normalized = platformPath(platform).normalize(path);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
export function platformDirectories({
  platform,
  home,
  environment = {},
}: {
  platform: HubPlatform;
  home: string;
  environment?: Readonly<Record<string, string | undefined>>;
}) {
  const path = platformPath(platform);
  const absolute = (value: string) => {
    if (
      !path.isAbsolute(value) ||
      /[\0\r\n]/.test(value) ||
      (platform !== 'win32' && value.includes('\\'))
    )
      throw new HubError(
        'invalid',
        'Use absolute platform configuration directories.',
      );
    return path.normalize(value);
  };
  home = absolute(home);
  const xdg = (name: string, fallback: string) =>
    environment[name] && posix.isAbsolute(environment[name]!)
      ? absolute(environment[name]!)
      : fallback;
  const config =
    platform === 'win32'
      ? absolute(environment.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : xdg('XDG_CONFIG_HOME', path.join(home, '.config'));
  const applicationSupport =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : config;
  const local =
    platform === 'win32'
      ? absolute(
          environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        )
      : applicationSupport;
  // Preserve the historical Windows fallback, including installations created
  // without LOCALAPPDATA. This must not silently move an existing DPAPI vault.
  const data =
    platform === 'win32'
      ? path.join(
          environment.LOCALAPPDATA || path.join(home, '.local', 'share'),
          'WaleedMcpHub',
        )
      : platform === 'darwin'
        ? path.join(applicationSupport, 'WaleedMcpHub')
        : path.join(
            xdg('XDG_DATA_HOME', path.join(home, '.local', 'share')),
            'waleed-mcp-hub',
          );
  const runtime = absolute(environment.HUB_DATA_DIR || data);
  const cache =
    platform === 'win32'
      ? path.join(local, 'WaleedMcpHub', 'Cache')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Caches', 'WaleedMcpHub')
        : path.join(
            xdg('XDG_CACHE_HOME', path.join(home, '.cache')),
            'waleed-mcp-hub',
          );
  // Reviewed package receipts and approval fingerprints remain under the runtime,
  // not a shared/global package cache. Preserve the existing Windows location.
  return {
    platform,
    home,
    config,
    applicationSupport,
    local,
    runtime,
    cache,
    packages: runtimePackageDirectory(runtime, platform),
  };
}
