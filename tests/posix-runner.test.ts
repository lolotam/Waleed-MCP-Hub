import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPosixProcessRunner } from '../packages/hub-core/src/adapters/native/posix-runner.js';
import { createPlatformProcessRunner } from '../packages/hub-core/src/adapters/native/platform-runner.js';
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  realpath: vi.fn(async (path) => path),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => true })),
}));
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let child: EventEmitter & {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
};
beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  });
  vi.mocked(spawn).mockImplementation((() => {
    child = Object.assign(new EventEmitter(), {
      pid: 45678,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as unknown as typeof spawn);
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', descriptor);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const request = (signal = AbortSignal.timeout(1000)) => ({
  executable: '/usr/bin/synthetic',
  arguments: ['literal', '$(not-a-shell)'],
  environment: { PATH: '/usr/bin' },
  signal,
  timeoutMs: 1000,
  outputLimitBytes: 1024,
});
async function started() {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
}
function exit() {
  child.emit('exit', 0);
  child.emit('close', 0);
}
it.each(['linux', 'darwin'] as const)(
  '%s platform execution uses a detached owned process group, an explicit environment, and group cleanup on normal exit',
  async (platform) => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
    const runner = await createPlatformProcessRunner({
        workingDirectory: '/runtime',
        allowedExecutables: ['/usr/bin/synthetic'],
      }),
      task = runner.run(request());
    await started();
    const bytes = Buffer.from('SYNTHETIC output');
    child.stdout.emit('data', bytes);
    exit();
    expect(await task).toMatchObject({
      stdout: 'SYNTHETIC output',
      outcome: 'exited',
      exitCode: 0,
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/synthetic',
      ['literal', '$(not-a-shell)'],
      expect.objectContaining({
        detached: true,
        shell: false,
        cwd: '/runtime',
        env: { PATH: '/usr/bin' },
      }),
    );
    expect(process.kill).toHaveBeenCalledWith(-45678, 'SIGKILL');
    expect(
      vi
        .mocked(process.kill)
        .mock.calls.filter((call) => call[1] === 'SIGKILL'),
    ).toHaveLength(1);
  },
);
it.each(['cancelled', 'timed_out', 'output_limit'] as const)(
  'cleans the whole POSIX group after %s and returns a bounded outcome',
  async (outcome) => {
    const runner = await createPosixProcessRunner({
        workingDirectory: '/runtime',
        allowedExecutables: ['/usr/bin/synthetic'],
      }),
      controller = new AbortController();
    const task = runner.run({
      ...request(controller.signal),
      timeoutMs: outcome === 'timed_out' ? 60 : 1000,
    });
    await started();
    if (outcome === 'cancelled') controller.abort();
    else if (outcome === 'output_limit')
      child.stdout.emit('data', Buffer.alloc(1025));
    await vi.waitFor(() =>
      expect(process.kill).toHaveBeenCalledWith(-45678, 'SIGTERM'),
    );
    exit();
    expect((await task).outcome).toBe(outcome);
    expect(process.kill).toHaveBeenCalledWith(-45678, 'SIGKILL');
  },
);
it('refuses unapproved/relative executables, excessive concurrency, invalid bounds and unsupported platforms without a spawn fallback', async () => {
  const runner = await createPosixProcessRunner({
    workingDirectory: '/runtime',
    allowedExecutables: ['/usr/bin/synthetic'],
    concurrency: 1,
  });
  for (const extra of [
    { executable: 'relative' },
    { executable: '/usr/bin/foreign' },
    { timeoutMs: 0 },
    { arguments: ['bad\0arg'] },
    { environment: { A: 'bad\0value' } },
  ])
    await expect(runner.run({ ...request(), ...extra })).rejects.toHaveProperty(
      'code',
      'invalid',
    );
  expect(spawn).not.toHaveBeenCalled();
  const task = runner.run(request());
  await started();
  await expect(runner.run(request())).rejects.toHaveProperty('code', 'busy');
  exit();
  await task;
  Object.defineProperty(process, 'platform', {
    value: 'win32',
    configurable: true,
  });
  await expect(
    createPosixProcessRunner({
      workingDirectory: '/runtime',
      allowedExecutables: ['/usr/bin/synthetic'],
    }),
  ).rejects.toHaveProperty('code', 'unavailable');
});
it('supports the same contained stdio callbacks and zero-filled stream chunks without returning a duplicate stdout copy', async () => {
  const runner = await createPosixProcessRunner({
    workingDirectory: '/runtime',
    allowedExecutables: ['/usr/bin/synthetic'],
  });
  const received: string[] = [],
    startedCallback = vi.fn(
      (write: (data: string) => void, end?: () => void) => {
        write('synthetic input\n');
        end?.();
      },
    );
  const task = runner.run({
    ...request(),
    session: true,
    stream: {
      started: startedCallback,
      stdout: (bytes) => {
        received.push(bytes.toString());
      },
    },
  });
  await started();
  const bytes = Buffer.from('stream payload');
  child.stdout.emit('data', bytes);
  exit();
  expect((await task).stdout).toBe('');
  expect(received).toEqual(['stream payload']);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(startedCallback).toHaveBeenCalledTimes(1);
});
