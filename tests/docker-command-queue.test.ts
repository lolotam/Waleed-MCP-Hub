import { describe, expect, it } from 'vitest';
import { queuedRunner } from '../packages/hub-core/src/integrations/docker-transport.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../packages/hub-core/src/ports.js';

// A runner whose commands finish when the test says so. Like the real
// runner, it refuses a command when every slot is taken or its timeout is
// shorter than 50 ms.
function controlledRunner(slots: number) {
  let active = 0;
  const started: ProcessRequest[] = [];
  const finishers: Array<() => void> = [];
  const runner: ProcessRunner = {
    async run(request) {
      if (request.timeoutMs < 50) throw new Error('invalid');
      if (active >= slots) throw new Error('busy');
      active++;
      started.push(request);
      await new Promise<void>((resolve) => finishers.push(resolve));
      active--;
      return { exitCode: 0, stdout: '', stderr: '', outcome: 'exited' };
    },
  };
  const finishNext = async () => {
    finishers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { runner, started, finishNext };
}

const request = (
  signal: AbortSignal = new AbortController().signal,
  timeoutMs = 60_000,
): ProcessRequest => ({
  executable: 'docker',
  arguments: ['info'],
  environment: {},
  timeoutMs,
  outputLimitBytes: 1024,
  signal,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the queue of the Docker short commands', () => {
  it('lets a third command wait for a free slot instead of failing', async () => {
    const inner = controlledRunner(2);
    const queued = queuedRunner(inner.runner, 2);
    const results: Promise<ProcessResult>[] = [
      queued.run(request()),
      queued.run(request()),
      queued.run(request()),
    ];
    await settle();
    expect(inner.started).toHaveLength(2);

    await inner.finishNext();
    expect(inner.started).toHaveLength(3);
    await inner.finishNext();
    await inner.finishNext();
    for (const result of await Promise.all(results))
      expect(result.outcome).toBe('exited');
  });

  it('ends the wait of a cancelled command without running it', async () => {
    const inner = controlledRunner(1);
    const queued = queuedRunner(inner.runner, 1);
    const first = queued.run(request());
    const controller = new AbortController();
    const second = queued.run(request(controller.signal));
    await settle();
    controller.abort();

    await expect(second).resolves.toMatchObject({ outcome: 'cancelled' });
    await inner.finishNext();
    await expect(first).resolves.toMatchObject({ outcome: 'exited' });
    expect(inner.started).toHaveLength(1);
  });

  it('counts the wait against the timeout of the command', async () => {
    const inner = controlledRunner(1);
    const queued = queuedRunner(inner.runner, 1);
    const first = queued.run(request());
    const late = queued.run(request(undefined, 30));

    await expect(late).resolves.toMatchObject({ outcome: 'timed_out' });
    await inner.finishNext();
    await expect(first).resolves.toMatchObject({ outcome: 'exited' });
    expect(inner.started).toHaveLength(1);
  });

  it('times out a command whose wait left less than the runner accepts', async () => {
    const inner = controlledRunner(1);
    const queued = queuedRunner(inner.runner, 1);
    const first = queued.run(request());
    const tight = queued.run(request(undefined, 80));
    // The slot frees with less than 50 ms of the 80 ms left.
    await new Promise((resolve) => setTimeout(resolve, 45));
    await inner.finishNext();

    await expect(tight).resolves.toMatchObject({ outcome: 'timed_out' });
    await expect(first).resolves.toMatchObject({ outcome: 'exited' });
    expect(inner.started).toHaveLength(1);
  });

  it('hands the slot of a command that waited out its timeout to the next one', async () => {
    const inner = controlledRunner(1);
    const queued = queuedRunner(inner.runner, 1);
    const first = queued.run(request());
    const late = queued.run(request(undefined, 30));
    const next = queued.run(request());
    await expect(late).resolves.toMatchObject({ outcome: 'timed_out' });

    await inner.finishNext();
    expect(inner.started).toHaveLength(2);
    expect(inner.started[1]?.timeoutMs).toBeLessThanOrEqual(60_000);
    await inner.finishNext();
    await expect(first).resolves.toMatchObject({ outcome: 'exited' });
    await expect(next).resolves.toMatchObject({ outcome: 'exited' });
  });
});
