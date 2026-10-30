import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
// No development condition: verify the compiled core and copied host assets.
import { createWindowsProcessRunner } from '@waleed/hub-core';

const MIB = 1024 * 1024;

if (process.platform !== 'win32') {
  console.info(
    'Windows process-host smoke test skipped on a non-Windows platform.',
  );
} else {
  const directory = await mkdtemp(
    join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'hub-compiled-'),
  );
  try {
    const runner = await createWindowsProcessRunner({
      allowedExecutables: [process.execPath],
      workingDirectory: directory,
    });
    const result = await runner.run({
      executable: process.execPath,
      arguments: ['-e', 'process.stdout.write("synthetic-runtime-fixture")'],
      environment: {},
      timeoutMs: 8000,
      outputLimitBytes: 1024,
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, {
      outcome: 'exited',
      exitCode: 0,
      stdout: 'synthetic-runtime-fixture',
      stderr: '',
    });

    // A session peer states its own ceiling and may live for an hour.
    const sessionRunner = await createWindowsProcessRunner({
      allowedExecutables: [process.execPath],
      workingDirectory: directory,
      session: true,
      maxTimeoutMs: 3_660_000,
    });
    const sessionRequest = {
      executable: process.execPath,
      arguments: [],
      environment: {},
      timeoutMs: 60_000,
      outputLimitBytes: 64 * MIB,
      signal: new AbortController().signal,
      session: { inputLimitBytes: 16 * MIB },
      stream: {
        started: () => undefined,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    };

    // A session run moves more than a megabyte in both directions and keeps
    // no output in its result.
    const controller = new AbortController();
    let echoed = 0;
    let beginWrite;
    const started = new Promise((resolve) => {
      beginWrite = resolve;
    });
    const sessionRun = sessionRunner.run({
      ...sessionRequest,
      arguments: ['-e', 'process.stdin.pipe(process.stdout)'],
      signal: controller.signal,
      stream: {
        started: (write) => beginWrite(write),
        stdout: (data) => {
          echoed += data.length;
        },
        stderr: () => undefined,
      },
    });
    const write = await Promise.race([
      started,
      sessionRun.then(() => {
        throw new Error('The synthetic session run ended before it started.');
      }),
    ]);
    const line = 's'.repeat(32 * 1024);
    for (let index = 0; index < 96; index++) write(line);
    const echoDeadline = Date.now() + 40_000;
    while (echoed < 3 * MIB && Date.now() < echoDeadline) await delay(25);
    assert.ok(
      echoed >= 3 * MIB,
      'The synthetic session target echoed less than three mebibytes.',
    );
    controller.abort();
    const sessionResult = await sessionRun;
    assert.equal(sessionResult.stdout, '');
    assert.equal(sessionResult.stderr, '');

    // A session run stops at its own output budget and still forwards stderr.
    let stderrBytes = 0;
    const limited = await sessionRunner.run({
      ...sessionRequest,
      arguments: [
        '-e',
        'process.stderr.write(Buffer.alloc(1024 * 1024, 65), () => process.exit(0))',
      ],
      outputLimitBytes: 512 * 1024,
      stream: {
        started: () => undefined,
        stdout: () => undefined,
        stderr: (data) => {
          stderrBytes += data.length;
        },
      },
    });
    assert.equal(limited.outcome, 'output_limit');
    assert.ok(stderrBytes > 0);
    assert.equal(limited.stdout, '');
    assert.equal(limited.stderr, '');

    // A session run stops once its stdin budget is spent.
    const overInput = await sessionRunner.run({
      ...sessionRequest,
      arguments: ['-e', 'process.stdin.resume()'],
      session: { inputLimitBytes: 64 * 1024 },
      stream: {
        started: (write) => {
          for (let index = 0; index < 3; index++) write('i'.repeat(32 * 1024));
        },
        stdout: () => undefined,
        stderr: () => undefined,
      },
    });
    assert.equal(overInput.outcome, 'output_limit');

    // A plain runner keeps today's limits and refuses a session request.
    await assert.rejects(
      createWindowsProcessRunner({
        allowedExecutables: [process.execPath],
        workingDirectory: directory,
        maxTimeoutMs: 600_001,
      }),
      { code: 'invalid' },
    );
    await assert.rejects(
      runner.run({
        ...sessionRequest,
        session: undefined,
        stream: undefined,
        timeoutMs: 8000,
        outputLimitBytes: MIB + 1,
      }),
      { code: 'invalid' },
    );
    await assert.rejects(
      runner.run({
        ...sessionRequest,
        timeoutMs: 8000,
      }),
      { code: 'invalid' },
    );

    // A session runner refuses a longer ceiling and out-of-range budgets.
    await assert.rejects(
      createWindowsProcessRunner({
        allowedExecutables: [process.execPath],
        workingDirectory: directory,
        session: true,
        maxTimeoutMs: 3_660_001,
      }),
      { code: 'invalid' },
    );
    await assert.rejects(
      sessionRunner.run({
        ...sessionRequest,
        outputLimitBytes: 64 * MIB + 1,
      }),
      { code: 'invalid' },
    );
    await assert.rejects(
      sessionRunner.run({
        ...sessionRequest,
        session: { inputLimitBytes: 16 * MIB + 1 },
      }),
      { code: 'invalid' },
    );
    await assert.rejects(
      sessionRunner.run({
        ...sessionRequest,
        stream: undefined,
      }),
      { code: 'invalid' },
    );
    console.info(
      'Compiled Windows process host smoke test passed (synthetic programs only).',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
