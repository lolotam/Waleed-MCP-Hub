import type { Stats } from 'node:fs';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PackageFault } from './fault.js';

// The caps of the watchdog: the unpacked tree plus the tarballs the cache
// keeps beside it.
export const WATCHDOG_MAX_BYTES = 800 * 1024 * 1024;
export const WATCHDOG_MAX_FILES = 60_000;

export interface WatchdogScan {
  bytes: number;
  files: number;
}

export interface WatchdogOptions {
  roots: readonly string[];
  maxBytes: number;
  maxFiles: number;
  intervalMs?: number;
  scan?: (roots: readonly string[]) => Promise<WatchdogScan>;
  // The reserve of the drive the run writes to: below it the run is stopped.
  minFreeBytes?: number;
  freePath?: string;
  // The measurement of the free space. A test injects its own.
  free?: (path: string) => Promise<number>;
}

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;
// An entry below a root that npm is deleting or renaming right now: on Windows
// a file pending deletion answers EPERM. It is skipped, not a breach; an error
// on a root itself still fails the scan.
const vanishing = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR', 'EPERM', 'EBUSY', 'EACCES'].includes(code(error) ?? '');

// The measurement of the folders npm writes to. Every entry that is not a
// folder counts as one file with its size; a link counts as one file and is
// never entered; a folder that is gone counts as nothing.
export const scanRoots = async (
  roots: readonly string[],
): Promise<WatchdogScan> => {
  let bytes = 0;
  let files = 0;
  const count = (info: Stats): void => {
    files += 1;
    bytes += info.size;
  };
  const walk = async (directory: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (vanishing(error)) return;
      throw error;
    }
    for (const name of names) {
      const path = join(directory, name);
      let info: Stats;
      try {
        info = await lstat(path);
      } catch (error) {
        if (vanishing(error)) continue;
        throw error;
      }
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      count(info);
    }
  };
  for (const root of roots) {
    let info: Stats;
    try {
      info = await lstat(root);
    } catch (error) {
      if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') continue;
      throw error;
    }
    if (info.isDirectory()) {
      await walk(root);
      continue;
    }
    count(info);
  }
  return { bytes, files };
};

// The free space of the drive the packages folder lives on.
export const freeBytes = async (path: string): Promise<number> => {
  let current = resolve(path);
  for (;;) {
    try {
      const stats = await statfs(current);
      return stats.bavail * stats.bsize;
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      const up = dirname(current);
      if (up === current) throw new PackageFault('install_limit');
      current = up;
    }
  }
};

// The watchdog around one npm run: it measures the folders the run writes to
// and aborts the run when the caps are passed. It also keeps the free-space
// reserve of the drive, because the run may not eat the space the hub needs
// for itself. It is best effort, not a quota:
// the run is still awaited after a breach, because the process tree has to be
// gone before anything is deleted. The watchdog never deletes anything itself.
export async function withWatchdog<T>(
  options: WatchdogOptions,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; breached: boolean }> {
  const intervalMs = options.intervalMs ?? 250;
  const scan = options.scan ?? scanRoots;
  const free = options.free ?? freeBytes;
  const controller = new AbortController();
  let breached = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (wake !== undefined) {
      const release = wake;
      wake = undefined;
      release();
    }
  };

  const onAbort = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // The scans never overlap: the next one starts after the previous one
  // finished and after the delay.
  const loop = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      let result: WatchdogScan;
      try {
        result = await scan(options.roots);
      } catch {
        // A scan that cannot measure counts as a breach: the hub fails closed.
        if (!stopped) {
          breached = true;
          controller.abort();
        }
        return;
      }
      if (stopped) return;
      if (result.bytes > options.maxBytes || result.files > options.maxFiles) {
        breached = true;
        controller.abort();
        return;
      }
      // The reserve of the drive: the run may not eat the space the hub needs
      // for itself. A measurement that fails counts as a breach.
      if (
        options.minFreeBytes !== undefined &&
        options.freePath !== undefined
      ) {
        let remaining: number;
        try {
          remaining = await free(options.freePath);
        } catch {
          remaining = -1;
        }
        if (stopped) return;
        if (remaining < options.minFreeBytes) {
          breached = true;
          controller.abort();
          return;
        }
      }
      await new Promise<void>((release) => {
        wake = release;
        timer = setTimeout(() => {
          timer = undefined;
          wake = undefined;
          release();
        }, intervalMs);
        timer.unref?.();
      });
    }
  };
  const scanning = loop();
  scanning.catch(() => undefined);
  try {
    const value = await run(controller.signal);
    stop();
    return { value, breached };
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
