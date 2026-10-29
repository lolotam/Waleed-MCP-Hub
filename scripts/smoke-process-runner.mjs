import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
// No development condition: verify the compiled core and copied host assets.
import { createWindowsProcessRunner } from '@waleed/hub-core';

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
    console.info(
      'Compiled Windows process host smoke test passed (synthetic program only).',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
