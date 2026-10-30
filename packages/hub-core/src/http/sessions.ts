import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ClientToken } from '@waleed/contracts';
import type { HubLifecycle } from '../lifecycle.js';
import { HubError } from '../errors.js';

export const httpSessionLimits = {
  total: 64,
  perToken: 8,
  requestsPerSession: 16,
  idleMs: 5 * 60_000,
  lifetimeMs: 60 * 60_000,
};
type Binding = Awaited<ReturnType<HubLifecycle['http']['bridge']>>;
type Entry = {
  id: string;
  tokenId: string;
  transport: StreamableHTTPServerTransport;
  binding?: Binding;
  closed: boolean;
  initialized: boolean;
  requests: number;
  responses: Set<ServerResponse>;
  idle?: ReturnType<typeof setTimeout>;
  lifetime?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
};
export function createHttpSessions(
  http: HubLifecycle['http'],
  now: () => number = Date.now,
  options: Partial<typeof httpSessionLimits> = {},
) {
  const limits = { ...httpSessionLimits, ...options };
  for (const key of Object.keys(limits) as Array<keyof typeof limits>)
    if (
      !Number.isInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > httpSessionLimits[key]
    )
      throw new Error('Invalid HTTP session limits.');
  const sessions = new Map<string, Entry>();
  const retiring = new Set<Promise<void>>();
  let closed = false;
  function retire(entry: Entry) {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    clearTimeout(entry.idle);
    clearTimeout(entry.lifetime);
    for (const response of entry.responses) {
      if (response.destroyed || response.writableEnded) continue;
      if (!response.headersSent) {
        response.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32000,
              message:
                'MCP session closed. Reinitialize with an active client token.',
            },
          }),
        );
      } else if (!response.writableEnded) response.end();
    }
    entry.responses.clear();
    // Close downstream streams before awaiting peers: pending results cannot escape.
    const closing = Promise.resolve().then(async () => {
      await entry.transport.close().catch(() => undefined);
      await entry.binding?.bridge.close().catch(() => undefined);
      entry.binding?.release();
    });
    entry.closing = closing;
    retiring.add(closing);
    void closing.finally(() => {
      retiring.delete(closing);
      sessions.delete(entry.id);
    });
    return closing;
  }
  const touch = (entry: Entry) => {
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      void retire(entry);
    }, limits.idleMs);
    entry.idle.unref();
  };
  const unsubscribe = http.tokens.onInvalidate((id) => {
    for (const entry of sessions.values())
      if (id === '*' || entry.tokenId === id) void retire(entry);
  });
  return {
    async acquire(
      token: ClientToken,
      id: string | undefined,
      initializing: boolean,
    ) {
      if (closed)
        throw new HubError('unavailable', 'HTTP transport is closed.');
      await http.tokens.requireActive(token.id);
      let entry: Entry;
      if (id) {
        const found = sessions.get(id);
        if (
          !found ||
          !found.initialized ||
          found.closed ||
          found.tokenId !== token.id
        )
          throw new HubError(
            'not_found',
            'MCP session not found. Reinitialize with this client token.',
          );
        entry = found;
      } else {
        if (!initializing)
          throw new HubError('invalid', 'Initialize an MCP session first.');
        if (
          sessions.size >= limits.total ||
          [...sessions.values()].filter((item) => item.tokenId === token.id)
            .length >= limits.perToken
        )
          throw new HubError(
            'busy',
            'HTTP session capacity reached. Close unused sessions.',
          );
        const sessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          enableJsonResponse: true,
          onsessioninitialized: () => {
            entry.initialized = true;
          },
          onsessionclosed: () => {
            void retire(entry);
          },
        });
        entry = {
          id: sessionId,
          tokenId: token.id,
          transport,
          closed: false,
          initialized: false,
          requests: 0,
          responses: new Set(),
        };
        sessions.set(sessionId, entry); // Reserve before any async bridge construction.
        const lifetime = Math.min(
          limits.lifetimeMs,
          token.expiresAt
            ? Date.parse(token.expiresAt) - now()
            : limits.lifetimeMs,
        );
        entry.lifetime = setTimeout(
          () => {
            void retire(entry);
          },
          Math.max(1, lifetime),
        );
        entry.lifetime.unref();
        touch(entry);
        try {
          entry.binding = await http.bridge(token.id);
          if (entry.closed) {
            await entry.binding.bridge.close();
            entry.binding.release();
            throw new HubError('unavailable', 'MCP session closed.');
          }
          await entry.binding.bridge.connect(transport);
          const onclose = transport.onclose;
          transport.onclose = () => {
            onclose?.();
            void retire(entry);
          };
        } catch {
          await retire(entry);
          throw new HubError('unavailable', 'MCP bridge unavailable.');
        }
      }
      if (entry.requests >= limits.requestsPerSession)
        throw new HubError('busy', 'Too many requests in this MCP session.');
      entry.requests++;
      touch(entry);
      let released = false;
      return {
        transport: entry.transport,
        track(response: ServerResponse) {
          if (entry.closed)
            throw new HubError('unavailable', 'MCP session closed.');
          entry.responses.add(response);
          const remove = () => entry.responses.delete(response);
          response.once('close', remove);
          response.once('finish', remove);
        },
        done() {
          if (!released) {
            released = true;
            entry.requests--;
          }
          if (!entry.initialized) void retire(entry);
        },
        close: () => retire(entry),
      };
    },
    async close() {
      closed = true;
      unsubscribe();
      await Promise.allSettled([...sessions.values()].map(retire));
      await Promise.allSettled([...retiring]);
    },
  };
}
