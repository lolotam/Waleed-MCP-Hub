import { afterEach, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanRoots,
  withWatchdog,
} from '../packages/hub-core/src/packages/watchdog.js';

describe('package-watchdog', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'wmh-ins-'));
    tempDirs.push(dir);
    return dir;
  }

  describe('1. scanRoots', () => {
    it('counts files and bytes across two roots', async () => {
      const tempDir = await createTempDir();
      const root1 = join(tempDir, 'root1');
      const root2 = join(tempDir, 'root2');
      await mkdir(join(root1, 'sub'), { recursive: true });
      await mkdir(root2, { recursive: true });

      await writeFile(join(root1, 'a.txt'), Buffer.alloc(100));
      await writeFile(join(root1, 'sub', 'b.txt'), Buffer.alloc(200));
      await writeFile(join(root2, 'c.txt'), Buffer.alloc(500));

      const result = await scanRoots([root1, root2]);
      expect(result.files).toBe(3);
      expect(result.bytes).toBe(800);
    });

    it('counts a missing root as 0', async () => {
      const tempDir = await createTempDir();
      const missing1 = join(tempDir, 'nonexistent1');
      const missing2 = join(tempDir, 'nonexistent2');

      const result = await scanRoots([missing1, missing2]);
      expect(result.files).toBe(0);
      expect(result.bytes).toBe(0);

      const existing = join(tempDir, 'existing');
      await mkdir(existing, { recursive: true });
      await writeFile(join(existing, 'file.txt'), Buffer.alloc(150));

      const mixed = await scanRoots([existing, missing1]);
      expect(mixed.files).toBe(1);
      expect(mixed.bytes).toBe(150);
    });

    it('counts a junction as one file and never enters it', async () => {
      const tempDir = await createTempDir();
      const target = join(tempDir, 'target');
      const root = join(tempDir, 'root');
      await mkdir(target, { recursive: true });
      await mkdir(root, { recursive: true });

      const largeSize = 5 * 1024 * 1024;
      await writeFile(join(target, 'large.bin'), Buffer.alloc(largeSize));

      const junctionPath = join(root, 'junction-link');
      await symlink(target, junctionPath, 'junction');

      const junctionStat = await lstat(junctionPath);
      expect(junctionStat.isSymbolicLink()).toBe(true);

      const result = await scanRoots([root]);
      expect(result.files).toBe(1);
      expect(result.bytes).toBeLessThan(largeSize);
      expect(result.bytes).toBe(junctionStat.size);
    });
  });

  describe('2. withWatchdog with a scan seam', () => {
    it('aborts the run signal on breach and returns breached: true', async () => {
      let aborted = false;
      const result = await withWatchdog(
        {
          roots: ['dummy'],
          maxBytes: 100,
          maxFiles: 10,
          intervalMs: 15,
          scan: async () => ({ bytes: 200, files: 1 }),
        },
        new AbortController().signal,
        async (signal) => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              aborted = true;
              resolve();
            } else {
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
            }
          });
          return 'completed';
        },
      );

      expect(aborted).toBe(true);
      expect(result.breached).toBe(true);
      expect(result.value).toBe('completed');
    });

    it('awaits the run: run resolves 300 ms after abort and withWatchdog does not resolve earlier', async () => {
      let runFinished = false;
      const start = Date.now();

      const result = await withWatchdog(
        {
          roots: ['dummy'],
          maxBytes: 100,
          maxFiles: 10,
          intervalMs: 10,
          scan: async () => ({ bytes: 500, files: 1 }),
        },
        new AbortController().signal,
        async (signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  runFinished = true;
                  resolve();
                }, 300);
              },
              { once: true },
            );
          });
          return 'slow-run';
        },
      );

      const elapsed = Date.now() - start;
      expect(runFinished).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(result.breached).toBe(true);
      expect(result.value).toBe('slow-run');
    });

    it('counts a scan that throws as a breach', async () => {
      let aborted = false;
      const result = await withWatchdog(
        {
          roots: ['dummy'],
          maxBytes: 10_000,
          maxFiles: 1000,
          intervalMs: 15,
          scan: async () => {
            throw new Error('scan failed');
          },
        },
        new AbortController().signal,
        async (signal) => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              aborted = true;
              resolve();
            } else {
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
            }
          });
          return 'scan-throw';
        },
      );

      expect(aborted).toBe(true);
      expect(result.breached).toBe(true);
      expect(result.value).toBe('scan-throw');
    });

    it('ensures scans never overlap while each one takes 50 ms', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      let totalScans = 0;

      const result = await withWatchdog(
        {
          roots: ['dummy'],
          maxBytes: 10_000,
          maxFiles: 1000,
          intervalMs: 10,
          scan: async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            totalScans++;
            await new Promise((r) => setTimeout(r, 50));
            concurrent--;
            return { bytes: 10, files: 1 };
          },
        },
        new AbortController().signal,
        async () => {
          await new Promise((r) => setTimeout(r, 220));
          return 'no-overlap';
        },
      );

      expect(maxConcurrent).toBe(1);
      expect(totalScans).toBeGreaterThanOrEqual(3);
      expect(result.breached).toBe(false);
      expect(result.value).toBe('no-overlap');
    });

    it('starts the next scan at least intervalMs after the previous one finished', async () => {
      const intervals: number[] = [];
      let lastFinishedAt = 0;
      const intervalMs = 40;

      await withWatchdog(
        {
          roots: ['dummy'],
          maxBytes: 10_000,
          maxFiles: 1000,
          intervalMs,
          scan: async () => {
            const now = Date.now();
            if (lastFinishedAt > 0) {
              intervals.push(now - lastFinishedAt);
            }
            await new Promise((r) => setTimeout(r, 10));
            lastFinishedAt = Date.now();
            return { bytes: 1, files: 1 };
          },
        },
        new AbortController().signal,
        async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 'ok';
        },
      );

      expect(intervals.length).toBeGreaterThanOrEqual(3);
      for (const interval of intervals) {
        // Account for Windows timer resolution / jitter
        expect(interval).toBeGreaterThanOrEqual(intervalMs - 5);
      }
    });

    it('starts no scan after the run settles', async () => {
      let scansAfterSettle = 0;
      let runSettled = false;

      await withWatchdog(
        {
          roots: ['dummy'],
          maxBytes: 10_000,
          maxFiles: 1000,
          intervalMs: 15,
          scan: async () => {
            if (runSettled) scansAfterSettle++;
            return { bytes: 1, files: 1 };
          },
        },
        new AbortController().signal,
        async () => {
          await new Promise((r) => setTimeout(r, 60));
          runSettled = true;
          return 'settled';
        },
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(scansAfterSettle).toBe(0);
    });

    it('forwards caller abort to the run signal while breached stays false', async () => {
      const caller = new AbortController();
      let signalAborted = false;

      const result = await withWatchdog(
        {
          roots: ['dummy'],
          maxBytes: 10_000,
          maxFiles: 1000,
          intervalMs: 15,
          scan: async () => ({ bytes: 1, files: 1 }),
        },
        caller.signal,
        async (signal) => {
          setTimeout(() => caller.abort(), 30);
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                signalAborted = signal.aborted;
                resolve();
              },
              { once: true },
            );
          });
          return 'caller-cancelled';
        },
      );

      expect(signalAborted).toBe(true);
      expect(result.breached).toBe(false);
      expect(result.value).toBe('caller-cancelled');
    });

    it('rethrows when the run rejects', async () => {
      const runError = new Error('explicit run failure');
      await expect(
        withWatchdog(
          {
            roots: ['dummy'],
            maxBytes: 10_000,
            maxFiles: 1000,
            intervalMs: 15,
            scan: async () => ({ bytes: 1, files: 1 }),
          },
          new AbortController().signal,
          async () => {
            throw runError;
          },
        ),
      ).rejects.toThrow(runError);
    });
  });
});
