import { createHash } from 'node:crypto';
import { createServer, createConnection, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { chmod } from 'node:fs/promises';
import {
  ToolCallRecordSchema,
  type ToolCallRecord,
  type HubState,
} from '@waleed/contracts';
import type { RequestLog } from './request-log.js';

// IPC only: browsers cannot submit log entries. The OS current-user pipe/socket
// permissions are not a claim of tamper-proof auditing against same-user code.
export function requestLogAddress(directory: string) {
  const key = createHash('sha256')
    .update(resolve(directory).toLowerCase())
    .digest('hex')
    .slice(0, 32);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wmh-request-log-${key}`
    : join(directory, `request-log-${key}.sock`);
}
export async function startRequestLogServer(
  directory: string,
  log: RequestLog,
  read: () => Promise<HubState>,
) {
  const clients = new Set<Socket>();
  let closed = false,
    processing = 0;
  const server = createServer((socket) => {
    if (closed || clients.size >= 16) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.setTimeout(1000, () => socket.destroy());
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2048) {
        chunk.fill(0);
        socket.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
      chunk.fill(0);
    });
    socket.on('error', () => undefined);
    socket.on('end', () => {
      if (closed || processing >= 16) return;
      processing++;
      void (async () => {
        const bytes = Buffer.concat(chunks);
        try {
          if (size > 2048) return;
          const parsed = ToolCallRecordSchema.safeParse(
            JSON.parse(bytes.toString('utf8')),
          );
          if (!parsed.success || parsed.data.agentId === 'hub_playground')
            return;
          const state = await read();
          if (
            closed ||
            !state.integrations?.some(
              (agent) => agent.agentId === parsed.data.agentId,
            )
          )
            return;
          log.append(parsed.data, false);
        } catch {
          /* Invalid metadata is dropped, never echoed or diagnosed. */
        } finally {
          processing--;
          bytes.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
      })();
    });
    socket.on('close', () => {
      clients.delete(socket);
      for (const chunk of chunks) chunk.fill(0);
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(
      {
        path: requestLogAddress(directory),
        readableAll: false,
        writableAll: false,
        exclusive: true,
      },
      () => {
        server.removeListener('error', reject);
        accept();
      },
    );
  });
  server.on('error', () => undefined);
  if (process.platform !== 'win32')
    await chmod(requestLogAddress(directory), 0o600);
  return {
    async close() {
      closed = true;
      for (const socket of clients) socket.destroy();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
export function createRequestLogSender(directory: string) {
  const pending = new Set<Promise<void>>();
  let closed = false;
  return {
    send(record: ToolCallRecord) {
      if (closed || pending.size >= 32) return;
      const parsed = ToolCallRecordSchema.safeParse(record);
      if (!parsed.success) return;
      const task = new Promise<void>((accept) => {
        const bytes = Buffer.from(JSON.stringify(parsed.data) + '\n');
        const socket = createConnection(requestLogAddress(directory));
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          bytes.fill(0);
          socket.destroy();
          accept();
        };
        socket.setTimeout(750, done);
        socket.once('error', done);
        socket.once('close', done);
        socket.once('connect', () => {
          socket.end(bytes, () => {
            bytes.fill(0);
          });
        });
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async close() {
      closed = true;
      await Promise.all([...pending]);
    },
  };
}
