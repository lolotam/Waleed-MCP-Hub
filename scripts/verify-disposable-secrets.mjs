// Opt-in real Docker keychain smoke. Fresh owned name only, no provider/account
// credentials, image runs, OAuth consent, or existing secret value reads.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createWindowsDiscoveryPorts,
  createWindowsProcessRunner,
  dockerCommand,
  dockerSecretStore,
} from '@waleed/hub-core';

if (process.platform !== 'win32' || !process.versions.node.startsWith('24.'))
  throw new Error('Use Node 24 on Windows.');
const directory = await mkdtemp(
  join('E:\\Dev\\Temp\\opencode', 'hub-p6-docker-secret-'),
);
const id = `wmh-secret-${randomUUID()}`;
const value = Buffer.from(`SYNTHETIC-DISPOSABLE-${randomUUID()}`);
let backend,
  attempted = false,
  clean = false;
try {
  const [executable] = await createWindowsDiscoveryPorts({
    workingDirectory: directory,
    environment: process.env,
  }).find(['docker'], AbortSignal.timeout(3000));
  assert(executable?.toLowerCase().endsWith('.exe'));
  const runner = await createWindowsProcessRunner({
    allowedExecutables: [executable],
    workingDirectory: directory,
  });
  backend = dockerSecretStore(
    dockerCommand(runner, executable, process.env),
    runner,
  );
  assert.equal(await backend.has(id, AbortSignal.timeout(20_000)), false);
  attempted = true;
  await backend.put(id, value, AbortSignal.timeout(30_000));
  assert.equal(await backend.has(id, AbortSignal.timeout(15_000)), true);
  assert.equal(
    backend.read,
    undefined,
    'No undocumented Docker plaintext-read method exists.',
  );
  await backend.delete(id, AbortSignal.timeout(20_000));
  assert.equal(await backend.has(id, AbortSignal.timeout(15_000)), false);
  clean = true;
  console.info(
    JSON.stringify(
      {
        dockerKeychain: 'stdin_set_presence_scoped_remove_passed',
        valueInArguments: false,
        plaintextValuesReturnedToHub: 0,
        explicitUpstreamMcpRequests: 0,
        imageRuns: 0,
        existingSecretsWritten: 0,
      },
      null,
      2,
    ),
  );
} finally {
  value.fill(0);
  if (attempted && !clean) {
    try {
      await backend.delete(id, AbortSignal.timeout(20_000));
      clean = !(await backend.has(id, AbortSignal.timeout(15_000)));
    } catch {
      console.error(
        `Inspect only the disposable owned secret ${id}; cleanup is unverified. No existing secret was modified.`,
      );
    }
  }
  if (!attempted || clean)
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
}
