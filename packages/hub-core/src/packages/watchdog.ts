import type { Stats } from 'node:fs';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PackageFault } from './fault.js';

// The caps of the watchdog: the unpacked tree plus the tarballs the cache
// keeps beside it. The entry cap counts folders as well as files, so it sits
// above the 50 000 files a tree may hold.
export const WATCHDOG_MAX_BYTES = 800 * 1024 * 1024;
export const WATCHDOG_MAX_FILES = 80_000;

export interface WatchdogScan {
  bytes: number;
  files: number;
}

// The caps a scan stops at: once one is passed the rest of the tree is not
// walked, because the run is over anyway.
export interface WatchdogLimits {
  maxBytes: number;
  maxFiles: number;
}

export interface WatchdogOptions {
  roots: readonly string[];
  maxBytes: number;
  maxFiles: number;
  intervalMs?: number;
  scan?: (
    roots: readonly string[],
    limits?: WatchdogLimits,
  ) => Promise<WatchdogScan>;
  // The reserve of the drive the run writes to: below it the run is stopped.
  minFreeBytes?: number;
  freePath?: string;
  // The measurement of the free space. A test injects its own.
  free?: (path: string) => Promise<number>;
}

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;
// An entry below a root that npm deleted or renamed while the scan ran. It is
// skipped, not a breach; an error on a root itself still fails the scan.
const vanishing = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR'].includes(code(error) ?? '');
// An entry the scan may not read. On Windows a file pending deletion answers
// EPERM while npm renames a folder, so a few are expected: each counts as one
// file. Past this many in one scan the tree cannot be measured and the scan
// fails, which the watchdog treats as a breach.
const unreadable = (error: unknown): boolean =>
  ['EPERM', 'EBUSY', 'EACCES'].includes(code(error) ?? '');
export const WATCHDOG_MAX_UNREADABLE = 256;

// The measurement of the folders npm writes to. Every entry counts as one
// file: a folder too, so a tree of empty folders cannot pass the cap unseen.
// A file adds its size; a link counts and is never entered; a folder that is
// gone counts as nothing. With limits the walk stops as soon as one is passed.
export const scanRoots = async (
  roots: readonly string[],
  limits?: WatchdogLimits,
): Promise<WatchdogScan> => {
  let bytes = 0;
  let files = 0;
  let denied = 0;
  const over = (): boolean =>
    limits !== undefined &&
    (bytes > limits.maxBytes || files > limits.maxFiles);
  const count = (info: Stats): void => {
    files += 1;
    bytes += info.size;
  };
  const deny = (error: unknown): void => {
    if (!unreadable(error)) throw error;
    denied += 1;
    if (denied > WATCHDOG_MAX_UNREADABLE) throw error;
  };
  const walk = async (directory: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (vanishing(error)) return;
      deny(error);
      return;
    }
    for (const name of names) {
      if (over()) return;
      const path = join(directory, name);
      let info: Stats;
      try {
        info = await lstat(path);
      } catch (error) {
        if (vanishing(error)) continue;
        deny(error);
        files += 1;
        continue;
      }
      if (info.isDirectory()) {
        files += 1;
        await walk(path);
        continue;
      }
      count(info);
    }
  };
  for (const root of roots) {
    if (over()) break;
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
  const limits: WatchdogLimits = {
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  };
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

  // The measurement against the caps and the reserve. A scan or a free-space
  // reading that fails counts as a breach: the hub fails closed.
  const passed = async (): Promise<boolean> => {
    try {
      const result = await scan(options.roots, limits);
      if (result.bytes > options.maxBytes || result.files > options.maxFiles)
        return true;
      if (options.minFreeBytes !== undefined && options.freePath !== undefined)
        return (await free(options.freePath)) < options.minFreeBytes;
      return false;
    } catch {
      return true;
    }
  };

  // The scans never overlap: the next one starts after the previous one
  // finished and after the delay.
  const loop = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      let result: WatchdogScan;
      try {
        result = await scan(options.roots, limits);
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
    // A run that ends while a scan is in flight would drop that scan's
    // result: the loop is awaited and the finished tree is measured once
    // more, so a tree over the caps at the end is still a breach.
    await scanning;
    if (!breached && (await passed())) breached = true;
    return { value, breached };
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
