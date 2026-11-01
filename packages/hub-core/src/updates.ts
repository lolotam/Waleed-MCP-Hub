import type { UpdateStatus } from '@waleed/contracts';

const repository = 'lolotam/Waleed-MCP-Hub';
const endpoint = `https://api.github.com/repos/${repository}/releases/latest`;
const version = (value: unknown): number[] | null =>
  typeof value === 'string' && /^v?\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value)
    ? value.replace(/^v/, '').split('.').map(Number)
    : null;
const newer = (left: number[], right: number[]) =>
  left[0] !== right[0]
    ? left[0]! > right[0]!
    : left[1] !== right[1]
      ? left[1]! > right[1]!
      : left[2]! > right[2]!;
export function createUpdateChecker(
  currentVersion: string,
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  const current = version(currentVersion);
  if (!current)
    throw new Error('The application build needs a stable semantic version.');
  let status: UpdateStatus = {
    currentVersion,
    latestVersion: null,
    state: 'not_checked',
    checkedAt: null,
    reason: 'none',
    releaseUrl: null,
    downloadUrl: null,
  };
  let pending: Promise<UpdateStatus> | undefined;
  const stop = new AbortController();
  return {
    status: () => structuredClone(status),
    check(): Promise<UpdateStatus> {
      if (pending) return pending;
      const age = status.checkedAt
        ? now() - Date.parse(status.checkedAt)
        : Infinity;
      if (age < (status.state === 'unavailable' ? 60_000 : 3_600_000))
        return Promise.resolve(structuredClone(status));
      pending = (async () => {
        const next: UpdateStatus = {
          ...status,
          latestVersion: null,
          releaseUrl: null,
          downloadUrl: null,
          checkedAt: new Date(now()).toISOString(),
          state: 'unavailable',
          reason: 'network',
        };
        try {
          const response = await fetcher(endpoint, {
            redirect: 'error',
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'Waleed-MCP-Hub',
            },
            signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
          });
          if (!response.ok) await response.body?.cancel();
          if (response.status === 404) next.reason = 'no_release';
          else if (response.status === 429 || response.status === 403)
            next.reason = 'rate_limit';
          else if (response.ok) {
            next.reason = 'invalid_response';
            if (!response.body) throw new Error('Missing release metadata.');
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > 128 * 1024)
                  throw new Error('Release metadata exceeded its bound.');
                chunks.push(part.value);
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            const release = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as {
              tag_name?: unknown;
              html_url?: unknown;
              draft?: unknown;
              prerelease?: unknown;
              assets?: Array<{
                name?: unknown;
                browser_download_url?: unknown;
              }>;
            };
            const latest = version(release.tag_name);
            if (
              !latest ||
              release.draft !== false ||
              release.prerelease !== false
            )
              throw new Error('Unsupported release.');
            const tag = release.tag_name as string;
            const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
            const downloadUrl = `https://github.com/${repository}/releases/download/${tag}/Waleed-MCP-Hub-Setup.exe`;
            if (
              release.html_url !== releaseUrl ||
              !Array.isArray(release.assets) ||
              !release.assets.some(
                (asset) =>
                  asset.name === 'Waleed-MCP-Hub-Setup.exe' &&
                  asset.browser_download_url === downloadUrl,
              )
            )
              throw new Error('Release links do not match this repository.');
            next.latestVersion = tag.replace(/^v/, '');
            next.state = newer(latest, current) ? 'available' : 'current';
            next.reason = 'none';
            next.releaseUrl = releaseUrl;
            next.downloadUrl = downloadUrl;
          }
        } catch {
          /* A remote failure never blocks local MCP management. */
        }
        status = next;
        return structuredClone(status);
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async close() {
      stop.abort();
      await pending;
    },
  };
}
export type UpdateChecker = ReturnType<typeof createUpdateChecker>;
