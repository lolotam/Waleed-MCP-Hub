import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  access,
  copyFile,
  link,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWindowsProcessRunner,
  type ProcessRunner,
} from '@waleed/hub-core';

const fixture = fileURLToPath(
  new URL('../fixtures/process-child.mjs', import.meta.url),
);
let directory: string;
let runner: ProcessRunner;
const pending: Promise<unknown>[] = [];
const controllers: AbortController[] = [];
const request = (mode: string, args: string[] = [], overrides = {}) => {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    executable: process.execPath,
    arguments: [fixture, mode, ...args],
    environment: {},
    timeoutMs: 8000,
    outputLimitBytes: 8192,
    signal: controller.signal,
    ...overrides,
  };
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFile(path: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const pids = JSON.parse(await readFile(path, 'utf8')) as {
        root?: number;
        child: number;
      };
      if (
        !Number.isSafeInteger(pids.child) ||
        pids.child <= 0 ||
        (pids.root !== undefined &&
          (!Number.isSafeInteger(pids.root) || pids.root <= 0))
      )
        throw new Error('Invalid fixture PIDs.');
      return pids;
    } catch {
      await delay(25);
    }
  }
  throw new Error('Synthetic fixture did not become ready.');
}
async function stopped(pid: number) {
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) await delay(25);
  expect(alive(pid)).toBe(false);
}

describe.skipIf(process.platform !== 'win32')(
  'Windows owned process runner',
  () => {
    beforeEach(async () => {
      directory = await mkdtemp(
        join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'hub-process space-'),
      );
      runner = await createWindowsProcessRunner({
        allowedExecutables: [process.execPath],
        workingDirectory: directory,
        concurrency: 1,
      });
    });
    afterEach(async () => {
      for (const controller of controllers.splice(0)) controller.abort();
      await Promise.allSettled(pending.splice(0));
      delete process.env.SYNTHETIC_HOST_ONLY;
      if (directory)
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 100,
        });
    });

    it('preserves spaces, Unicode, empty arguments, quotes, backslashes, and shell metacharacters as data', async () => {
      process.env.SYNTHETIC_HOST_ONLY = 'not-inherited';
      const args = [
        '',
        'Case Sensitive',
        'أهلا 世界',
        'a"b',
        'a\\"b',
        'trailing\\',
        '"',
        '&& echo never > injected.txt',
        '$(never-run)',
        '%SYNTHETIC_HOST_ONLY%',
      ];
      const result = await runner.run(
        request('arguments', args, {
          environment: { SYNTHETIC_DECLARED: 'synthetic-value' },
        }),
      );
      expect(result.outcome).toBe('exited');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        arguments: args,
        cwd: directory,
        declared: 'synthetic-value',
        inherited: null,
      });
      expect(result.stderr).toBe('fixture stderr');
      await expect(access(join(directory, 'injected.txt'))).rejects.toThrow();
    }, 15_000);

    it('returns nonzero target exit status without treating it as host success or launch failure', async () => {
      const result = await runner.run(request('nonzero'));
      expect(result).toMatchObject({ outcome: 'exited', exitCode: 7 });
    }, 15_000);

    it('supplies bounded stdin separately from cancellation control and closes it at EOF', async () => {
      const input = 'cancel\nSYNTHETIC-STDIN-ONLY\nأهلا\n';
      const result = await runner.run({ ...request('stdin'), stdin: input });
      expect(result).toMatchObject({
        outcome: 'exited',
        exitCode: 0,
        stderr: '',
      });
      expect(JSON.parse(result.stdout)).toEqual({
        bytes: Buffer.byteLength(input),
        sha256: createHash('sha256').update(input).digest('hex'),
      });
      const empty = await runner.run(request('stdin'));
      expect(JSON.parse(empty.stdout).bytes).toBe(0);
      await expect(
        runner.run({ ...request('stdin'), stdin: 'x'.repeat(32 * 1024 + 1) }),
      ).rejects.toMatchObject({ code: 'invalid' });
    }, 15_000);

    it('launches a reviewed executable from a path containing spaces and Unicode', async () => {
      const executable = join(directory, 'Synthetic Node تجربة.exe');
      // Exercise the exact Unicode/spaced executable path without making every
      // run depend on first-launch scanning of a fresh, large Node binary copy.
      // Removing this owned link never removes the installed executable.
      try {
        await link(process.execPath, executable);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await copyFile(process.execPath, executable);
      }
      const isolated = await createWindowsProcessRunner({
        allowedExecutables: [executable],
        workingDirectory: directory,
      });
      const result = await isolated.run({
        ...request('arguments', ['quoted path']),
        executable,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).arguments).toEqual(['quoted path']);
    }, 15_000);

    it('rejects relative paths, unapproved executables, cmd/bat shims, NULs, and unbounded inputs before execution', async () => {
      for (const executable of [
        'node.exe',
        'C:\\synthetic\\launcher.cmd',
        'C:\\synthetic\\launcher.bat',
        'C:\\Windows\\System32\\cmd.exe',
        '\\\\server\\share\\program.exe',
      ]) {
        await expect(
          runner.run({ ...request('hold'), executable }),
        ).rejects.toMatchObject({ code: 'invalid' });
      }
      await expect(
        runner.run({ ...request('hold'), timeoutMs: 0 }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        runner.run({ ...request('hold'), outputLimitBytes: 2 ** 30 }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        runner.run({ ...request('hold'), arguments: ['\0'] }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        runner.run({
          ...request('hold'),
          environment: { Path: 'a', PATH: 'b' },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('never launches an already cancelled request', async () => {
      const controller = new AbortController();
      controller.abort();
      expect(
        await runner.run(request('hold', [], { signal: controller.signal })),
      ).toMatchObject({
        outcome: 'cancelled',
        exitCode: null,
        stdout: '',
        stderr: '',
      });
    });

    it('fails closed on an invalid executable without returning raw host diagnostics or paths', async () => {
      const executable = join(directory, 'invalid.exe');
      await writeFile(executable, 'SYNTHETIC-SENSITIVE-HOST-ERROR');
      const invalidRunner = await createWindowsProcessRunner({
        allowedExecutables: [executable],
        workingDirectory: directory,
      });
      try {
        await invalidRunner.run({ ...request('hold'), executable });
        throw new Error('Invalid PE execution unexpectedly succeeded.');
      } catch (error) {
        expect(error).toMatchObject({ code: 'unavailable' });
        expect(String(error)).not.toContain(directory);
        expect(String(error)).not.toContain('SYNTHETIC-SENSITIVE-HOST-ERROR');
      }
    }, 15_000);

    it('caps combined stdout/stderr and terminates the owned job when output floods', async () => {
      const result = await runner.run(
        request('flood', [], { outputLimitBytes: 2048 }),
      );
      expect(result.outcome).toBe('output_limit');
      expect(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      ).toBeLessThanOrEqual(2048);
    }, 15_000);

    it('times out the complete owned tree while leaving an unrelated process alive', async () => {
      const unrelated = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore', shell: false },
      );
      try {
        const file = join(directory, 'tree.json');
        const operation = runner.run(
          request('tree', [file], { timeoutMs: 5000 }),
        );
        pending.push(operation);
        const pids = await waitFile(file);
        expect((await operation).outcome).toBe('timed_out');
        await stopped(pids.root!);
        await stopped(pids.child);
        expect(alive(unrelated.pid!)).toBe(true);
      } finally {
        const exited = new Promise<void>((resolve) =>
          unrelated.once('close', () => resolve()),
        );
        unrelated.kill();
        await exited;
      }
    }, 15_000);

    it('cancels a running tree and rejects concurrent work instead of creating an unbounded queue', async () => {
      const controller = new AbortController();
      controllers.push(controller);
      const file = join(directory, 'cancel.json');
      const operation = runner.run(
        request('tree', [file], { signal: controller.signal }),
      );
      pending.push(operation);
      const pids = await waitFile(file);
      await expect(runner.run(request('hold'))).rejects.toMatchObject({
        code: 'busy',
      });
      controller.abort();
      expect((await operation).outcome).toBe('cancelled');
      await stopped(pids.root!);
      await stopped(pids.child);
      expect((await runner.run(request('nonzero'))).exitCode).toBe(7);
    }, 20_000);

    it('reaps descendants even when the root exits normally', async () => {
      const file = join(directory, 'root-exit.json');
      const result = await runner.run(request('exit-with-child', [file]));
      expect(result).toMatchObject({ outcome: 'exited', exitCode: 0 });
      const pids = await waitFile(file);
      await stopped(pids.child);
    }, 15_000);

    it('fails closed and reaps the tree if the isolated host crashes', async () => {
      const file = join(directory, 'crash.json');
      const operation = runner.run(request('crash-host', [file]));
      // Attach the rejection assertion immediately so a host crash cannot become
      // an unhandled test promise while the readiness file is being inspected.
      const rejected = expect(operation).rejects.toMatchObject({
        code: 'unavailable',
      });
      pending.push(rejected);
      const pids = await waitFile(file);
      await rejected;
      await stopped(pids.root!);
      await stopped(pids.child);
    }, 15_000);
  },
);
