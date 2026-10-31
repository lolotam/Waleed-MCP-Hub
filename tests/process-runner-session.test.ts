import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWindowsProcessRunner,
  type ProcessRequest,
} from '@waleed/hub-core';

const MIB = 1024 * 1024;

describe.skipIf(process.platform !== 'win32')(
  'Windows process runner session validation',
  () => {
    let directory: string;

    beforeEach(async () => {
      directory = await realpath(
        await mkdtemp(
          join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'hub-session-'),
        ),
      );
    });
    afterEach(async () => {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    });

    // Every case here is refused before a process is launched.
    const sessionRequest = (): ProcessRequest => ({
      executable: process.execPath,
      arguments: ['-e', 'process.stdin.pipe(process.stdout)'],
      environment: {},
      timeoutMs: 60_000,
      outputLimitBytes: 64 * MIB,
      signal: new AbortController().signal,
      session: { inputLimitBytes: 16 * MIB },
      stream: {
        started: () => undefined,
        stdout: () => undefined,
      },
    });
    const plainRequest = (): ProcessRequest => ({
      executable: process.execPath,
      arguments: ['-e', 'process.stdout.write("synthetic")'],
      environment: {},
      timeoutMs: 8000,
      outputLimitBytes: 1024,
      signal: new AbortController().signal,
    });

    it('refuses a session request on a runner without the session option', async () => {
      const runner = await createWindowsProcessRunner({
        allowedExecutables: [process.execPath],
        workingDirectory: directory,
      });
      await expect(runner.run(sessionRequest())).rejects.toMatchObject({
        code: 'invalid',
      });
    });

    it('refuses session budgets outside the session ranges', async () => {
      const runner = await createWindowsProcessRunner({
        allowedExecutables: [process.execPath],
        workingDirectory: directory,
        session: true,
        maxTimeoutMs: 3_660_000,
      });
      await expect(
        runner.run({ ...sessionRequest(), outputLimitBytes: 64 * MIB + 1 }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        runner.run({
          ...sessionRequest(),
          session: { inputLimitBytes: 16 * MIB + 1 },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        runner.run({
          ...sessionRequest(),
          session: { inputLimitBytes: 0 },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('refuses a session request without the duplex stream seam', async () => {
      const runner = await createWindowsProcessRunner({
        allowedExecutables: [process.execPath],
        workingDirectory: directory,
        session: true,
        maxTimeoutMs: 3_660_000,
      });
      await expect(
        runner.run({
          executable: process.execPath,
          arguments: ['-e', 'process.stdin.pipe(process.stdout)'],
          environment: {},
          timeoutMs: 60_000,
          outputLimitBytes: 64 * MIB,
          signal: new AbortController().signal,
          session: { inputLimitBytes: 16 * MIB },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('refuses a session ceiling above the session maximum', async () => {
      await expect(
        createWindowsProcessRunner({
          allowedExecutables: [process.execPath],
          workingDirectory: directory,
          session: true,
          maxTimeoutMs: 3_660_001,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      // A session runner states its own ceiling; there is no session default.
      await expect(
        createWindowsProcessRunner({
          allowedExecutables: [process.execPath],
          workingDirectory: directory,
          session: true,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('keeps the plain runner limits unchanged', async () => {
      await expect(
        createWindowsProcessRunner({
          allowedExecutables: [process.execPath],
          workingDirectory: directory,
          maxTimeoutMs: 600_001,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      const runner = await createWindowsProcessRunner({
        allowedExecutables: [process.execPath],
        workingDirectory: directory,
      });
      await expect(
        runner.run({ ...plainRequest(), outputLimitBytes: 1024 * MIB + 1 }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });
  },
);
