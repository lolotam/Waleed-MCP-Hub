import { StringDecoder } from 'node:string_decoder';
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ProcessRequest, ProcessRunner } from '../../ports.js';
import { RuntimeFault } from '../../runtime/capabilities.js';

// Session budgets: one operation, the whole session and the window between two
// operations.
const OPERATION_OUTPUT = 1024 * 1024;
const OPERATION_INPUT = 1024 * 1024;
const OPERATION_MESSAGES = 512;
const SESSION_OUTPUT = 64 * 1024 * 1024;
const SESSION_INPUT = 16 * 1024 * 1024;
const SESSION_MESSAGES = 32_768;
const IDLE_OUTPUT = 64 * 1024;
const IDLE_INPUT = 64 * 1024;
const IDLE_MESSAGES = 32;
const LINE_BYTES = 128 * 1024;
const MESSAGE_BYTES = 32 * 1024;

export class ContainedStdioTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  setProtocolVersion?: Transport['setProtocolVersion'];
  private controller = new AbortController();
  private task: Promise<unknown> | undefined;
  private write: ((value: string) => void) | undefined;
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private messages = 0;
  // Session mode: the request asks for it, so the transport owns the budgets.
  private readonly session: boolean;
  private started = false;
  private closed = false;
  private inOperation = false;
  private breached = false;
  // A session line is measured in bytes, so the raw buffer is kept as bytes.
  private raw = Buffer.alloc(0);
  private operationOutput = 0;
  private operationInput = 0;
  private operationReceived = 0;
  private operationSent = 0;
  private idleOutput = 0;
  private idleInput = 0;
  private idleReceived = 0;
  private idleSent = 0;
  private totalOutput = 0;
  private totalInput = 0;
  private totalReceived = 0;
  private totalSent = 0;
  constructor(
    private runner: ProcessRunner,
    private request: Omit<ProcessRequest, 'signal' | 'stream' | 'stdin'>,
    private signal: AbortSignal,
  ) {
    this.session = request.session !== undefined;
  }
  async start() {
    if (this.task) throw new RuntimeFault('protocol_error');
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const stream: NonNullable<ProcessRequest['stream']> = {
        started: (write) => {
          this.write = write;
          resolve();
        },
        stdout: (bytes) => {
          if (this.session) this.receive(bytes);
          else this.receivePlain(bytes);
        },
      };
      // Only a session run accounts the second stream.
      if (this.session)
        stream.stderr = (bytes) => {
          this.countOutput(bytes.length);
        };
      this.task = this.runner
        .run({
          ...this.request,
          signal: AbortSignal.any([this.controller.signal, this.signal]),
          stream,
        })
        .then((result) => {
          if (!this.write)
            reject(
              new RuntimeFault(
                result.outcome === 'timed_out'
                  ? 'timed_out'
                  : 'dependency_unavailable',
              ),
            );
          if (!this.controller.signal.aborted)
            this.onerror?.(
              new RuntimeFault(
                result.outcome === 'output_limit'
                  ? 'limit_exceeded'
                  : result.outcome === 'timed_out'
                    ? 'timed_out'
                    : 'protocol_error',
              ),
            );
          this.onclose?.();
        })
        .catch(() => {
          reject(new RuntimeFault('dependency_unavailable'));
          this.onerror?.(new RuntimeFault('dependency_unavailable'));
          this.onclose?.();
        });
    });
  }
  // Session mode only: opens the operation window and resets its counters.
  beginOperation() {
    if (
      !this.session ||
      !this.started ||
      this.inOperation ||
      this.closed ||
      this.controller.signal.aborted
    )
      throw new RuntimeFault('protocol_error');
    this.inOperation = true;
    this.operationOutput = 0;
    this.operationInput = 0;
    this.operationReceived = 0;
    this.operationSent = 0;
  }
  // Session mode only: closes the operation window and resets the counters of
  // the window that follows it.
  endOperation() {
    if (!this.session || !this.inOperation)
      throw new RuntimeFault('protocol_error');
    this.inOperation = false;
    this.idleOutput = 0;
    this.idleInput = 0;
    this.idleReceived = 0;
    this.idleSent = 0;
  }
  async send(message: JSONRPCMessage) {
    if (this.breached) throw new RuntimeFault('limit_exceeded');
    if (!this.write || this.controller.signal.aborted)
      throw new RuntimeFault('protocol_error');
    const data = JSON.stringify(message) + '\n';
    const size = Buffer.byteLength(data, 'utf8');
    if (size > MESSAGE_BYTES) {
      if (this.session) this.breach();
      throw new RuntimeFault('limit_exceeded');
    }
    if (this.session) {
      this.countSent(size);
      if (this.breached) throw new RuntimeFault('limit_exceeded');
    }
    this.write(data);
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    await this.task;
  }
  // The plain path is unchanged: characters per line, 512 messages, no stderr.
  private receivePlain(bytes: Buffer) {
    this.pending += this.decoder.write(bytes);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.length > 128 * 1024 || ++this.messages > 512)
        throw new RuntimeFault('limit_exceeded');
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
      } catch {
        this.controller.abort();
        this.onerror?.(new RuntimeFault('protocol_error'));
      }
    }
    if (Buffer.byteLength(this.pending, 'utf8') > 128 * 1024) {
      this.controller.abort();
      this.onerror?.(new RuntimeFault('limit_exceeded'));
    }
  }
  // Session path: bytes are counted before decoding and a line is measured in
  // bytes, so a line split over chunks is still one line.
  private receive(bytes: Buffer) {
    // An aborted session delivers nothing more, whatever ended it.
    if (this.breached || this.controller.signal.aborted) return;
    this.countOutput(bytes.length);
    if (this.breached) return;
    this.raw = Buffer.concat([this.raw, bytes]);
    let newline: number;
    while ((newline = this.raw.indexOf(10)) !== -1) {
      const line = this.raw.subarray(0, newline);
      this.raw = this.raw.subarray(newline + 1);
      if (line.length > LINE_BYTES) {
        this.breach();
        return;
      }
      this.countReceived();
      if (this.breached || this.controller.signal.aborted) return;
      try {
        this.onmessage?.(
          JSONRPCMessageSchema.parse(JSON.parse(line.toString('utf8'))),
        );
      } catch {
        this.controller.abort();
        this.onerror?.(new RuntimeFault('protocol_error'));
      }
    }
    if (this.raw.length > LINE_BYTES) this.breach();
  }
  private countOutput(size: number) {
    this.totalOutput += size;
    if (this.inOperation) this.operationOutput += size;
    else this.idleOutput += size;
    if (
      this.totalOutput > SESSION_OUTPUT ||
      (this.inOperation
        ? this.operationOutput > OPERATION_OUTPUT
        : this.idleOutput > IDLE_OUTPUT)
    )
      this.breach();
  }
  private countReceived() {
    this.totalReceived++;
    if (this.inOperation) this.operationReceived++;
    else this.idleReceived++;
    if (
      this.totalReceived > SESSION_MESSAGES ||
      (this.inOperation
        ? this.operationReceived > OPERATION_MESSAGES
        : this.idleReceived > IDLE_MESSAGES)
    )
      this.breach();
  }
  private countSent(size: number) {
    this.totalSent++;
    this.totalInput += size;
    if (this.inOperation) {
      this.operationSent++;
      this.operationInput += size;
    } else {
      this.idleSent++;
      this.idleInput += size;
    }
    if (
      this.totalSent > SESSION_MESSAGES ||
      this.totalInput > SESSION_INPUT ||
      (this.inOperation
        ? this.operationSent > OPERATION_MESSAGES ||
          this.operationInput > OPERATION_INPUT
        : this.idleSent > IDLE_MESSAGES || this.idleInput > IDLE_INPUT)
    )
      this.breach();
  }
  // One breach ends the session: the transport stops, reports the limit once
  // and never delivers or accepts anything else.
  private breach() {
    if (this.breached) return;
    this.breached = true;
    this.controller.abort();
    this.onerror?.(new RuntimeFault('limit_exceeded'));
  }
}
