import { StringDecoder } from 'node:string_decoder';
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ProcessRequest, ProcessRunner } from '../../ports.js';
import { RuntimeFault } from '../../runtime/capabilities.js';

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
  constructor(
    private runner: ProcessRunner,
    private request: Omit<ProcessRequest, 'signal' | 'stream' | 'stdin'>,
    private signal: AbortSignal,
  ) {}
  async start() {
    if (this.task) throw new RuntimeFault('protocol_error');
    await new Promise<void>((resolve, reject) => {
      this.task = this.runner
        .run({
          ...this.request,
          signal: AbortSignal.any([this.controller.signal, this.signal]),
          stream: {
            started: (write) => {
              this.write = write;
              resolve();
            },
            stdout: (bytes) => {
              this.pending += this.decoder.write(bytes);
              let newline: number;
              while ((newline = this.pending.indexOf('\n')) !== -1) {
                const line = this.pending.slice(0, newline);
                this.pending = this.pending.slice(newline + 1);
                if (line.length > 128 * 1024 || ++this.messages > 512)
                  throw new RuntimeFault('limit_exceeded');
                try {
                  this.onmessage?.(
                    JSONRPCMessageSchema.parse(JSON.parse(line)),
                  );
                } catch {
                  this.controller.abort();
                  this.onerror?.(new RuntimeFault('protocol_error'));
                }
              }
              if (Buffer.byteLength(this.pending, 'utf8') > 128 * 1024) {
                this.controller.abort();
                this.onerror?.(new RuntimeFault('limit_exceeded'));
              }
            },
          },
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
  async send(message: JSONRPCMessage) {
    if (!this.write || this.controller.signal.aborted)
      throw new RuntimeFault('protocol_error');
    const data = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(data, 'utf8') > 32 * 1024)
      throw new RuntimeFault('limit_exceeded');
    this.write(data);
  }
  async close() {
    this.controller.abort();
    await this.task;
  }
}
