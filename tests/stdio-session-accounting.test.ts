import { describe, expect, it, vi } from 'vitest';
import { ContainedStdioTransport } from '../packages/hub-core/src/adapters/mcp/stdio.js';
import { RuntimeFault } from '../packages/hub-core/src/runtime/capabilities.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../packages/hub-core/src/ports.js';

// No process is started: the fake captures the stream callbacks and ends the
// run only when the request signal aborts.
class FakeRunner implements ProcessRunner {
  readonly writes: string[] = [];
  private stream: NonNullable<ProcessRequest['stream']> | undefined;
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.stream = request.stream;
    request.stream?.started((data) => {
      this.writes.push(data);
    });
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) resolve();
      else
        request.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
    });
    return { exitCode: null, stdout: '', stderr: '', outcome: 'cancelled' };
  }
  stdout(data: Buffer) {
    this.stream?.stdout(data);
  }
  stderr(data: Buffer) {
    this.stream?.stderr?.(data);
  }
  // Only a session run asks for the second stream.
  get accountsStderr(): boolean {
    return this.stream?.stderr !== undefined;
  }
}

const buildRequest = (
  session: boolean,
): Omit<ProcessRequest, 'signal' | 'stream' | 'stdin'> => ({
  executable: 'C:\\fake\\mcp-server.exe',
  arguments: [],
  environment: {},
  timeoutMs: 60_000,
  outputLimitBytes: session ? 64 * 1024 * 1024 : 1024 * 1024,
  ...(session ? { session: { inputLimitBytes: 16 * 1024 * 1024 } } : {}),
});

const open = async (session: boolean) => {
  const runner = new FakeRunner();
  const transport = new ContainedStdioTransport(
    runner,
    buildRequest(session),
    new AbortController().signal,
  );
  const messages: unknown[] = [];
  const errors: RuntimeFault[] = [];
  transport.onmessage = (message) => {
    messages.push(message);
  };
  transport.onerror = (error) => {
    errors.push(error as RuntimeFault);
  };
  await transport.start();
  return { runner, transport, messages, errors };
};

const notification = (text: string) => ({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: { text },
});
const frame = (message: unknown) => `${JSON.stringify(message)}\n`;
const reply = (id: number) => ({ jsonrpc: '2.0' as const, id, result: {} });
// The same 44 000 characters: one line of three-byte characters is over
// 128 KiB, the same line in ASCII is not.
const overhead = JSON.stringify(notification('')).length;
const euroFrame = frame(notification('€'.repeat(44000 - overhead)));
const asciiFrame = frame(notification('a'.repeat(44000 - overhead)));
const fault = (action: () => unknown): RuntimeFault => {
  try {
    action();
  } catch (error) {
    return error as RuntimeFault;
  }
  throw new Error('The action did not fail.');
};
const reasons = (errors: RuntimeFault[]) => errors.map((error) => error.reason);

describe('contained stdio transport accounting', () => {
  it('keeps the plain behaviour when the request has no session', async () => {
    const { runner, transport, messages, errors } = await open(false);
    expect(runner.accountsStderr).toBe(false);
    expect(fault(() => transport.beginOperation()).reason).toBe(
      'protocol_error',
    );
    expect(fault(() => transport.endOperation()).reason).toBe('protocol_error');
    for (let index = 0; index < 512; index++)
      runner.stdout(Buffer.from(frame(notification('plain'))));
    expect(messages).toHaveLength(512);
    expect(errors).toEqual([]);
    expect(
      fault(() => runner.stdout(Buffer.from(frame(notification('plain')))))
        .reason,
    ).toBe('limit_exceeded');
    await transport.close();
  });

  it('breaches on a stderr flood between operations and inside an operation', async () => {
    const idle = await open(true);
    expect(idle.runner.accountsStderr).toBe(true);
    idle.runner.stderr(Buffer.alloc(64 * 1024));
    expect(idle.errors).toEqual([]);
    idle.runner.stderr(Buffer.from('x'));
    expect(reasons(idle.errors)).toEqual(['limit_exceeded']);
    await idle.transport.close();

    const busy = await open(true);
    busy.transport.beginOperation();
    busy.runner.stderr(Buffer.alloc(1024 * 1024));
    expect(busy.errors).toEqual([]);
    busy.runner.stderr(Buffer.from('x'));
    expect(reasons(busy.errors)).toEqual(['limit_exceeded']);
    await busy.transport.close();
  });

  it('measures one line in bytes and not in characters', async () => {
    const euroLine = euroFrame.slice(0, -1);
    const asciiLine = asciiFrame.slice(0, -1);
    expect(euroLine.length).toBe(44000);
    expect(asciiLine.length).toBe(44000);
    expect(Buffer.byteLength(euroLine, 'utf8')).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(asciiLine, 'utf8')).toBeLessThan(128 * 1024);
    const euro = await open(true);
    euro.runner.stdout(Buffer.from(euroFrame, 'utf8'));
    expect(reasons(euro.errors)).toEqual(['limit_exceeded']);
    expect(euro.messages).toEqual([]);
    await euro.transport.close();

    const ascii = await open(true);
    ascii.runner.stdout(Buffer.from(asciiFrame, 'utf8'));
    expect(ascii.errors).toEqual([]);
    expect(ascii.messages).toHaveLength(1);
    await ascii.transport.close();
  });

  it('delivers a message split over two chunks once', async () => {
    const { runner, transport, messages, errors } = await open(true);
    const line = frame(notification('split'));
    const middle = Math.floor(line.length / 2);
    runner.stdout(Buffer.from(line.slice(0, middle)));
    runner.stdout(Buffer.from(line.slice(middle)));
    expect(messages).toHaveLength(1);
    expect(errors).toEqual([]);
    // One message was counted: 31 more fit, the 33rd breaches the window.
    for (let index = 0; index < 31; index++)
      runner.stdout(Buffer.from(frame(notification('idle'))));
    expect(errors).toEqual([]);
    runner.stdout(Buffer.from(frame(notification('idle'))));
    expect(reasons(errors)).toEqual(['limit_exceeded']);
    expect(messages).toHaveLength(32);
    await transport.close();
  });

  it('allows 32 idle notifications and breaches on the 33rd', async () => {
    const { runner, transport, messages, errors } = await open(true);
    for (let index = 0; index < 32; index++)
      runner.stdout(Buffer.from(frame(notification('idle'))));
    expect(errors).toEqual([]);
    expect(messages).toHaveLength(32);
    runner.stdout(Buffer.from(frame(notification('idle'))));
    expect(reasons(errors)).toEqual(['limit_exceeded']);
    expect(messages).toHaveLength(32);
    await transport.close();
  });

  it('keeps idle pings inside the between-operations budget', async () => {
    vi.useFakeTimers();
    try {
      const { runner, transport, messages, errors } = await open(true);
      for (let minute = 0; minute < 5; minute++) {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
        for (let ping = 0; ping < 4; ping++) {
          runner.stdout(
            Buffer.from(
              frame({
                jsonrpc: '2.0',
                id: minute * 4 + ping,
                method: 'ping',
              }),
            ),
          );
          await transport.send(reply(minute * 4 + ping));
        }
        transport.beginOperation();
        transport.endOperation();
      }
      expect(errors).toEqual([]);
      expect(messages).toHaveLength(20);
      // The session is still open and still accepts protocol traffic.
      await transport.send(reply(99));
      expect(reasons(errors)).toEqual([]);
      await transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows 600 messages over two operations and breaches on 513 in one', async () => {
    const { runner, transport, messages, errors } = await open(true);
    transport.beginOperation();
    for (let index = 0; index < 300; index++)
      runner.stdout(Buffer.from(frame(notification('first'))));
    transport.endOperation();
    transport.beginOperation();
    for (let index = 0; index < 300; index++)
      runner.stdout(Buffer.from(frame(notification('second'))));
    transport.endOperation();
    expect(messages).toHaveLength(600);
    expect(errors).toEqual([]);
    await transport.close();

    const single = await open(true);
    single.transport.beginOperation();
    for (let index = 0; index < 512; index++)
      single.runner.stdout(Buffer.from(frame(notification('single'))));
    expect(single.errors).toEqual([]);
    single.runner.stdout(Buffer.from(frame(notification('single'))));
    expect(reasons(single.errors)).toEqual(['limit_exceeded']);
    expect(single.messages).toHaveLength(512);
    await single.transport.close();
  });

  it('bounds the messages sent between operations and inside an operation', async () => {
    const idle = await open(true);
    for (let index = 0; index < 32; index++)
      await idle.transport.send(reply(index));
    expect(idle.errors).toEqual([]);
    await expect(idle.transport.send(reply(32))).rejects.toThrowError(
      RuntimeFault,
    );
    expect(reasons(idle.errors)).toEqual(['limit_exceeded']);
    await idle.transport.close();

    const busy = await open(true);
    busy.transport.beginOperation();
    for (let index = 0; index < 512; index++)
      await busy.transport.send(reply(index));
    expect(busy.errors).toEqual([]);
    await expect(busy.transport.send(reply(512))).rejects.toThrowError(
      RuntimeFault,
    );
    expect(reasons(busy.errors)).toEqual(['limit_exceeded']);
    await busy.transport.close();
  });

  it('stops delivering messages and refuses sends after a breach', async () => {
    const { runner, transport, messages, errors } = await open(true);
    for (let index = 0; index < 33; index++)
      runner.stdout(Buffer.from(frame(notification('idle'))));
    expect(reasons(errors)).toEqual(['limit_exceeded']);
    runner.stdout(Buffer.from(frame(notification('late'))));
    expect(messages).toHaveLength(32);
    await expect(transport.send(reply(1))).rejects.toThrowError(RuntimeFault);
    await transport.close();
  });

  it('delivers nothing after a malformed line ends the session', async () => {
    const { runner, transport, messages, errors } = await open(true);
    runner.stdout(
      Buffer.from(`not json\n${frame(notification('after'))}`, 'utf8'),
    );
    runner.stdout(Buffer.from(frame(notification('late'))));
    expect(messages).toHaveLength(0);
    expect(reasons(errors)).toEqual(['protocol_error']);
    await transport.close();
  });
});
