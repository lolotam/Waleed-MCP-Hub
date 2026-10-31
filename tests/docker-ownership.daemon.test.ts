import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureInstallRecord,
  writeBootRecord,
} from '../packages/hub-core/src/runtime/boot.js';
import { emptyState } from '../packages/hub-core/src/state.js';
import { removeTestContainers } from './helpers/docker-test-cleanup.js';

const inCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

const cli = (args: string[]) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.once('error', () => resolve({ code: -1, stdout: '' }));
    child.once('close', (code) => resolve({ code: code ?? -1, stdout }));
  });

// A tiny image that is already pulled: nothing is downloaded here.
const recipes: Array<{ match: RegExp; command: string[] }> = [
  { match: /^(alpine|busybox):/, command: ['sleep', '600'] },
  { match: /^redis:.*-alpine$/, command: [] },
  {
    match: /^node:.*-alpine$/,
    command: ['node', '-e', 'setInterval(() => {}, 1000)'],
  },
];

// The real daemon of this test: the availability of the daemon and one tiny
// image that is already pulled.
type Availability =
  | { available: true; image: string; command: string[] }
  | { available: false; reason: string };

async function inspectDocker(): Promise<Availability> {
  if (inCi) return { available: false, reason: 'continuous integration' };
  const version = await cli(['version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0 || !version.stdout.trim())
    return { available: false, reason: 'the docker daemon is unavailable' };
  const images = await cli(['images', '--format', '{{.Repository}}:{{.Tag}}']);
  const local = images.stdout.split(/\r?\n/).map((line) => line.trim());
  for (const recipe of recipes) {
    const image = local.find((name) => recipe.match.test(name));
    if (image) return { available: true, image, command: recipe.command };
  }
  return { available: false, reason: 'no tiny image is pulled locally' };
}

const availability = await inspectDocker();
if (!availability.available)
  console.info(
    `The real-daemon Docker test is skipped: ${availability.reason}.`,
  );
const image = availability.available ? availability.image : '';
const command = availability.available ? availability.command : [];

// The marker files of the agent, wherever they are.
async function markerFiles(directory: string, agentId: string) {
  const found: string[] = [];
  const walk = async (folder: string) => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.json')) found.push(path);
    }
  };
  await walk(join(directory, 'owned-agent-containers', agentId));
  return found.sort();
}

// Polls an observable condition until it holds: the test waits for what it
// observes, never for a guessed duration.
async function until(
  condition: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline)
      throw new Error('The condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Stops a bridge of this test and waits for it to exit, within a bound: the
// cleanup never races a bridge that still touches Docker or its marker
// files. Only the children this test spawned are signalled.
async function stopBridge(
  child: ChildProcess | undefined,
  timeoutMs = 10_000,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  child.kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

// The fixture of the bridge, run through the sources of the hub.
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe.skipIf(!availability.available)(
  'Docker ownership with a real daemon',
  () => {
    it('removes the container of a crashed bridge with the next bridge start', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'wmh-daemon-'));
      const { installId } = await ensureInstallRecord(directory);
      await writeBootRecord(directory);
      // The registry of the agent: the next bridge reads it at its start.
      const registry = join(directory, 'state.json');
      const state = emptyState();
      state.integrations = [
        {
          agentId: 'opencode',
          configPath: join(directory, 'opencode.json'),
          entryHash: 'a'.repeat(64),
          syncedRevision: 0,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      await writeFile(registry, JSON.stringify(state));
      await writeFile(
        join(directory, 'safety.json'),
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          securityEvents: [],
          operations: [],
        }),
      );
      const child = spawn(
        process.execPath,
        [
          '--conditions=development',
          '--import',
          'tsx',
          fixture('docker-crash-bridge.mjs'),
          directory,
          'opencode',
          image,
          ...command,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let replacement: ReturnType<typeof spawn> | undefined;
      let nonce = '';
      // Set when the test itself failed: its error is the one reported.
      let bodyFailed = false;
      let teardownError: unknown;
      try {
        nonce = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('the bridge did not start')),
            60_000,
          );
          let output = '';
          child.stdout.on('data', (chunk) => {
            output += chunk;
            const line = output.split(/\r?\n/).find((item) => item.trim());
            if (!line) return;
            clearTimeout(timer);
            resolve(line.trim().split(/\s+/)[1] ?? '');
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`the bridge exited early: ${code}`));
          });
        });
        expect(nonce).not.toBe('');
        // The bridge crashes: its container stays behind.
        child.kill();
        await new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        const listed = await cli([
          'ps',
          '--all',
          '--quiet',
          '--no-trunc',
          '--filter',
          `label=wmh.install=${installId}`,
          '--filter',
          `label=wmh.client=${nonce}`,
        ]);
        expect(listed.stdout.trim()).not.toBe('');
        // The next bridge of the agent starts through the production
        // startup: it recovers the orphan at its start, with no manual
        // recovery and no new admission.
        replacement = spawn(
          process.execPath,
          [
            '--conditions=development',
            '--import',
            'tsx',
            fixture('docker-replacement-bridge.mjs'),
            registry,
            'opencode',
          ],
          { stdio: ['pipe', 'pipe', 'ignore'] },
        );
        await until(async () => {
          const remaining = await cli([
            'ps',
            '--all',
            '--quiet',
            '--no-trunc',
            '--filter',
            `label=wmh.install=${installId}`,
            '--filter',
            `label=wmh.client=${nonce}`,
          ]);
          // A failed listing proves nothing: its empty output is never read
          // as "no container".
          if (remaining.code !== 0) return false;
          if (remaining.stdout.trim() !== '') return false;
          // The marker of the session is deleted with its container.
          return (await markerFiles(directory, 'opencode')).length === 0;
        });
        expect(await markerFiles(directory, 'opencode')).toHaveLength(0);
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        // Every step runs, even after one failed, so the containers and the
        // data directory always go. A failed test keeps its own error and a
        // teardown failure is then only printed, since it can leave a
        // container behind; otherwise the first teardown failure is thrown.
        const steps = [
          () => stopBridge(child),
          () => stopBridge(replacement),
          () =>
            removeTestContainers(cli, {
              installId,
              agentId: 'opencode',
              nonce,
            }),
          () => rm(directory, { recursive: true, force: true, maxRetries: 4 }),
        ];
        for (const step of steps) {
          try {
            await step();
          } catch (error) {
            if (bodyFailed) console.error(error);
            else teardownError ??= error;
          }
        }
      }
      // Reached only when the test itself passed.
      if (teardownError !== undefined) throw teardownError;
    }, 240_000);
  },
);
