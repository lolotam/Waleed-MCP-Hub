// Invoked with the bundled Node from a disposable directory, never the workspace runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [app, fixture] = process.argv.slice(2);
const { createWindowsProcessRunner } = await import(
  pathToFileURL(join(app, 'node_modules/@waleed/hub-core/dist/index.js')).href
);
const runner = await createWindowsProcessRunner({
  allowedExecutables: [process.execPath],
  workingDirectory: dirname(fixture),
  concurrency: 1,
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
async function waitUntil(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}
const unrelated = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'ignore', shell: false },
);
try {
  for (const outcome of ['cancelled', 'timed_out']) {
    const controller = new AbortController(),
      file = join(dirname(fixture), `${outcome}.json`);
    const operation = runner.run({
      executable: process.execPath,
      arguments: [fixture, 'tree', file],
      environment: {},
      timeoutMs: 12000,
      outputLimitBytes: 1024,
      signal: controller.signal,
    });
    // Attach rejection immediately while waiting for the synthetic tree readiness file.
    const settled = operation.then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    try {
      let pids;
      await waitUntil(async () => {
        try {
          pids = JSON.parse(await readFile(file, 'utf8'));
          return true;
        } catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError)
            return false;
          throw error;
        }
      }, 'Packaged containment fixture did not become ready.');
      assert(
        Number.isSafeInteger(pids.root) &&
          pids.root > 0 &&
          Number.isSafeInteger(pids.child) &&
          pids.child > 0,
      );
      assert(alive(pids.root) && alive(pids.child));
      if (outcome === 'cancelled') controller.abort();
      const completion = await settled;
      if (completion.error) throw completion.error;
      assert.equal(completion.result.outcome, outcome);
      await waitUntil(
        () => !alive(pids.root) && !alive(pids.child),
        'Packaged JobObject left a synthetic descendant running.',
      );
      assert(alive(unrelated.pid), 'Unrelated synthetic process was affected.');
    } finally {
      controller.abort();
      await settled;
    }
  }
} finally {
  const exited = new Promise((resolve) => unrelated.once('close', resolve));
  unrelated.kill();
  await exited;
}
console.info(
  'Bundled runtime JobObject cancels and times out owned trees without affecting an unrelated process.',
);
