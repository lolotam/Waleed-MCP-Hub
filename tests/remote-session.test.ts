import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Connector } from '@waleed/contracts';
import {
  restrictedFetch,
  sessionMcpHttpTransport,
  SseFramer,
  type RemoteSession,
} from '../packages/hub-core/src/adapters/mcp/http.js';
import { remoteSessionPeer } from '../packages/hub-core/src/integrations/bridge.js';
import { RuntimeFault } from '../packages/hub-core/src/runtime/capabilities.js';
import {
  mcpSessionFixture,
  sessionResult,
  type SessionEvent,
  type SessionFixture,
  type SessionFixtureOptions,
} from './helpers/mcp-session-http.js';
import { connector as syntheticConnector } from './helpers/runtime.js';

const wait = (ms = 30) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Polls an observable condition until it holds or the timeout passes. The
// tests wait for what they observe, never for a guessed duration.
async function until(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline)
      throw new Error('The condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Opened {
  fixture: SessionFixture;
  session: RemoteSession;
  client: Client;
  // The lifetime of the peer.
  controller: AbortController;
  // Rejects when the peer dies.
  death: Promise<never>;
  deaths(): number;
  errors(): Error[];
}

// One session peer against the local fixture. The peer dies once: the first
// death ends the test's expectation, the rest are ignored.
async function open(
  options: SessionFixtureOptions = {},
  configure?: (fixture: SessionFixture) => void,
  mode: 'streamable_http' | 'sse' = 'streamable_http',
): Promise<Opened> {
  const fixture = await mcpSessionFixture({ transport: mode, ...options });
  configure?.(fixture);
  let deaths = 0;
  const errors: Error[] = [];
  let rejectDeath!: (error: Error) => void;
  const death = new Promise<never>((_, reject) => {
    rejectDeath = reject;
  });
  death.catch(() => undefined);
  const controller = new AbortController();
  const session = sessionMcpHttpTransport(
    `${fixture.origin}/mcp`,
    mode,
    controller.signal,
    () => {
      deaths += 1;
      rejectDeath(new Error('The peer died.'));
    },
    undefined,
    fixture.origin,
  );
  const client = new Client(
    { name: 'synthetic-session-client', version: '1' },
    { capabilities: {} },
  );
  client.onerror = (error) => {
    errors.push(error);
  };
  await client.connect(session.transport, { timeout: 10_000 });
  return {
    fixture,
    session,
    client,
    controller,
    death,
    deaths: () => deaths,
    errors: () => errors,
  };
}

// The GET notification stream stays open and quiet.
function keepStreamOpen(event: SessionEvent) {
  if (event.method !== 'GET') return false;
  event.response.writeHead(200, { 'content-type': 'text/event-stream' });
  // The headers reach the client at once.
  event.response.flushHeaders();
  return true;
}

// The default answer of the fixture: one JSON result.
function jsonAnswer(event: SessionEvent, options: SessionFixtureOptions) {
  const message = event.messages[0];
  if (!message || message.id === undefined) {
    event.response.writeHead(202);
    event.response.end();
    return;
  }
  event.response.writeHead(200, {
    'content-type': 'application/json',
    'mcp-session-id': 'synthetic-session',
  });
  event.response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: sessionResult(message, options),
    }),
  );
}

// The answer of the fixture as an SSE stream: the result is one event, with
// or without an id, and the stream may stay open.
function sseAnswer(
  event: SessionEvent,
  options: SessionFixtureOptions,
  keepOpen = false,
  eventId = false,
  failure = false,
) {
  if (keepStreamOpen(event)) return;
  const message = event.messages[0];
  if (!message || message.id === undefined) {
    event.response.writeHead(202);
    event.response.end();
    return;
  }
  const payload = failure
    ? {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'synthetic refusal' },
      }
    : {
        jsonrpc: '2.0',
        id: message.id,
        result: sessionResult(message, options),
      };
  event.response.writeHead(200, {
    'content-type': 'text/event-stream',
    'mcp-session-id': 'synthetic-session',
  });
  if (eventId) event.response.write('id: 7\n');
  event.response.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  if (!keepOpen) event.response.end();
}

// The records of one framer: the forwarded lines and the dispatched events.
function framerRecords() {
  const lines: string[] = [];
  const events: (string | undefined)[] = [];
  return {
    sink: {
      bytes: () => undefined,
      text: (value: string) => {
        lines.push(value);
      },
      event: (data: string | undefined) => {
        events.push(data);
      },
    },
    lines,
    events,
  };
}

// The reason of the fault a framer raises, or undefined when it accepts the
// stream.
function framerFault(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof RuntimeFault ? error.reason : 'unknown';
  }
}

const list = (client: Client, timeout = 5000) =>
  client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema, {
    timeout,
  });
const call = (client: Client, timeout = 5000, signal?: AbortSignal) =>
  client.request(
    { method: 'tools/call', params: { name: 'fixture_first', arguments: {} } },
    CallToolResultSchema,
    { timeout, ...(signal ? { signal } : {}) },
  );

// The client read the bytes of the stream: they are the pending bytes of
// its framers until the event that carries them is dispatched.
async function read(opened: Opened, bytes: number): Promise<void> {
  await until(() => opened.session.inspect().pendingBytes >= bytes);
}

describe('remote session mode', () => {
  it('passes 100 requests and 3 MiB across operations', async () => {
    const opened = await open({ catalogBytes: 30 * 1024 });
    try {
      for (let operation = 0; operation < 20; operation++) {
        opened.session.beginOperation();
        for (let request = 0; request < 5; request++) await list(opened.client);
        opened.session.endOperation();
      }
      expect(
        opened.fixture.seen.filter((event) => event.method === 'POST').length,
      ).toBe(102);
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('keeps a quiet GET stream alive across a long silence', async () => {
    const opened = await open();
    try {
      // The GET stream stays open and quiet for longer than the socket
      // timeout of five seconds.
      await wait(6000);
      expect(opened.deaths()).toBe(0);
      expect(
        opened.fixture.seen.filter((event) => event.method === 'GET').length,
      ).toBe(1);
      opened.session.beginOperation();
      expect(await call(opened.client)).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  }, 30_000);

  it('keeps the session alive when a POST SSE response completes', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => sseAnswer(event, fixture.options);
    });
    try {
      opened.session.beginOperation();
      expect(await list(opened.client)).toMatchObject({
        tools: [{ name: 'fixture_first' }],
      });
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
      expect(opened.errors()).toHaveLength(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('passes a 200 KiB image result and a 900 KiB tool catalog', async () => {
    const opened = await open({
      catalogBytes: 900 * 1024,
      imageBytes: 200 * 1024,
    });
    try {
      opened.session.beginOperation();
      await list(opened.client);
      opened.session.endOperation();
      opened.session.beginOperation();
      expect(await call(opened.client)).toMatchObject({
        content: [{ type: 'text' }, { type: 'image' }],
      });
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('breaches on a multiline SSE event over 1 MiB', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (keepStreamOpen(event)) return;
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        event.response.writeHead(200, { 'content-type': 'text/event-stream' });
        const line = 'x'.repeat(64 * 1024);
        for (let index = 0; index < 17; index++)
          event.response.write(`data: ${line}\n`);
        event.response.write('\n');
      };
    });
    try {
      opened.session.beginOperation();
      await expect(
        Promise.race([list(opened.client, 3000), opened.death]),
      ).rejects.toBeDefined();
      opened.session.endOperation();
      expect(opened.deaths()).toBeGreaterThan(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('breaches on an unterminated SSE event over 1 MiB', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (keepStreamOpen(event)) return;
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        event.response.writeHead(200, { 'content-type': 'text/event-stream' });
        const line = 'x'.repeat(64 * 1024);
        for (let index = 0; index < 17; index++)
          event.response.write(`data: ${line}\n`);
      };
    });
    try {
      opened.session.beginOperation();
      await expect(
        Promise.race([list(opened.client, 3000), opened.death]),
      ).rejects.toBeDefined();
      opened.session.endOperation();
      expect(opened.deaths()).toBeGreaterThan(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('breaches on a JSON array of 513 messages', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (keepStreamOpen(event)) return;
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        const messages = Array.from({ length: 513 }, (_, index) => ({
          jsonrpc: '2.0',
          id: index,
          result: {},
        }));
        event.response.writeHead(200, { 'content-type': 'application/json' });
        event.response.end(JSON.stringify(messages));
      };
    });
    try {
      opened.session.beginOperation();
      await expect(
        Promise.race([list(opened.client, 3000), opened.death]),
      ).rejects.toBeDefined();
      opened.session.endOperation();
      expect(opened.deaths()).toBeGreaterThan(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('counts an incomplete event against the between-operations budget', async () => {
    const opened = await open();
    try {
      opened.session.beginOperation();
      await list(opened.client);
      // The server sends an event that never ends.
      const incomplete = 'data: ' + 'x'.repeat(100 * 1024);
      opened.fixture.push(incomplete);
      // The client read the stream: the pending bytes are on the client.
      await read(opened, incomplete.length);
      expect(opened.deaths()).toBe(0);
      // The operation ends: the incomplete event belongs to the window
      // between two operations.
      opened.session.endOperation();
      expect(opened.deaths()).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('charges every incomplete event again in the next window', async () => {
    const opened = await open();
    try {
      opened.session.beginOperation();
      await list(opened.client);
      // The server sends an event that never ends.
      const incomplete = 'data: ' + 'x'.repeat(50 * 1024);
      opened.fixture.push(incomplete);
      // The client read the stream: the pending bytes are on the client.
      await read(opened, incomplete.length);
      expect(opened.deaths()).toBe(0);
      // The first boundary charges the fifty kilobytes of the event.
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
      // The next operation adds thirty kilobytes to the same event.
      opened.session.beginOperation();
      const more = 'y'.repeat(30 * 1024);
      opened.fixture.push(more);
      await read(opened, incomplete.length + more.length);
      expect(opened.deaths()).toBe(0);
      // The second boundary charges the whole event again: eighty kilobytes
      // are more than the sixty-four kilobytes between two operations.
      opened.session.endOperation();
      expect(opened.deaths()).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('splits CR, LF and CRLF line ends like the SDK parser', () => {
    const { sink, events, lines } = framerRecords();
    const framer = new SseFramer(sink, false);
    framer.push(Buffer.from('data: one\r\rdata: two\n\ndata: three\r\n\r\n'));
    expect(events).toEqual(['one', 'two', 'three']);
    expect(lines).toEqual([
      'data: one\n',
      '\n',
      'data: two\n',
      '\n',
      'data: three\n',
      '\n',
    ]);
  });

  it('treats a CRLF split across two chunks as one line end', () => {
    const { sink, events, lines } = framerRecords();
    const framer = new SseFramer(sink, false);
    framer.push(Buffer.from('data: split\r'));
    // The CR waits for the next chunk: the LF completes the line end.
    framer.push(Buffer.from('\n\r\n'));
    expect(events).toEqual(['split']);
    expect(lines).toEqual(['data: split\n', '\n']);
  });

  it('keeps the pending bytes of the event that follows a dispatch', () => {
    const { sink } = framerRecords();
    const framer = new SseFramer(sink, false);
    // The keepalive is dispatched; the event behind it stays pending.
    framer.push(Buffer.from(': keepalive\n\ndata: ' + 'x'.repeat(60_000)));
    framer.push(Buffer.from('y'.repeat(20_000)));
    expect(framer.pending).toBe(80_006);
  });

  it('breaches the between-operations budget on the pending bytes of an event', async () => {
    const opened = await open();
    try {
      opened.session.beginOperation();
      await list(opened.client);
      // One chunk carries a dispatched event and the incomplete one behind
      // it; the next chunk adds to it.
      const first = ': keepalive\n\ndata: ' + 'x'.repeat(60_000);
      opened.fixture.push(first);
      await read(opened, 60_006);
      const second = 'y'.repeat(20_000);
      opened.fixture.push(second);
      await read(opened, 80_006);
      expect(opened.deaths()).toBe(0);
      // The pending bytes of the incomplete event are more than the sixty-four
      // kilobytes between two operations.
      opened.session.endOperation();
      expect(opened.deaths()).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('caps the data of one event at one MiB', () => {
    const { sink } = framerRecords();
    const framer = new SseFramer(sink, false);
    const line = 'x'.repeat(64 * 1024);
    // The event never ends: its data lines are the cap that fires.
    expect(
      framerFault(() => {
        for (let index = 0; index < 17; index++)
          framer.push(Buffer.from(`data: ${line}\n`));
      }),
    ).toBe('limit_exceeded');
  });

  it('caps the pending buffer of an unterminated line at one MiB', () => {
    const { sink } = framerRecords();
    const framer = new SseFramer(sink, false);
    const chunk = Buffer.from('data: ' + 'x'.repeat(64 * 1024));
    // The line never ends: the pending buffer is the cap that fires. The
    // input is split across chunks.
    expect(
      framerFault(() => {
        for (let index = 0; index < 16; index++) {
          framer.push(chunk.subarray(0, 32 * 1024));
          framer.push(chunk.subarray(32 * 1024));
        }
      }),
    ).toBe('limit_exceeded');
  });

  it('caps a pending event of completed lines plus an unfinished line', () => {
    const { sink } = framerRecords();
    const framer = new SseFramer(sink, false);
    // The event holds a line that was completed but never dispatched and a
    // line that never ends: the whole event is capped.
    const complete = Buffer.from('data: ' + 'x'.repeat(60 * 1024) + '\n');
    const unfinished = Buffer.from('data: ' + 'y'.repeat(1000 * 1024));
    expect(
      framerFault(() => {
        framer.push(complete);
        framer.push(unfinished);
      }),
    ).toBe('limit_exceeded');
  });

  it('does not count a later event against the pending cap of the current one', () => {
    const { sink, events } = framerRecords();
    const framer = new SseFramer(sink, false);
    // The first event keeps a megabyte of its own: it is never dispatched.
    framer.push(Buffer.from('data: ' + 'x'.repeat(60 * 1024)));
    framer.push(Buffer.from('y'.repeat(940 * 1024)));
    // One chunk finishes the first event with ten kilobytes and carries a
    // second event of thirty kilobytes. The second event never counts
    // against the first one.
    const chunk = Buffer.concat([
      Buffer.from('z'.repeat(10 * 1024) + '\n\n'),
      Buffer.from('data: ' + 'w'.repeat(30 * 1024) + '\n\n'),
    ]);
    expect(framerFault(() => framer.push(chunk))).toBeUndefined();
    // Both events were dispatched.
    expect(events).toHaveLength(2);
    expect(framer.pending).toBe(0);
  });

  it('breaches on 513 CR-delimited notifications', async () => {
    const opened = await open();
    try {
      opened.session.beginOperation();
      await list(opened.client);
      // The notifications are delimited by carriage returns alone.
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      });
      opened.fixture.push(`data: ${notification}\r\r`.repeat(513) + '\n');
      await expect(
        Promise.race([list(opened.client, 3000), opened.death]),
      ).rejects.toBeDefined();
      expect(opened.deaths()).toBeGreaterThan(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('drops a CR-delimited id on a POST response stream', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (keepStreamOpen(event)) return;
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        // The id of the stream is delimited by a carriage return alone: the
        // hub drops it and forwards the data that follows.
        event.response.writeHead(200, {
          'content-type': 'text/event-stream',
          'mcp-session-id': 'synthetic-session',
        });
        event.response.write('id: 7\r');
        event.response.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: sessionResult(message, fixture.options),
          })}\n\n`,
        );
      };
    });
    try {
      opened.session.beginOperation();
      // The answer of the request arrives: the id did not swallow it.
      expect(await list(opened.client, 3000)).toMatchObject({
        tools: [{ name: 'fixture_first' }],
      });
      opened.session.endOperation();
      // The body was ended: the fixture sees the closed POST connection.
      await until(() => opened.fixture.closedPosts() > 0);
      expect(opened.deaths()).toBe(0);
      expect(opened.errors()).toHaveLength(0);
      // The peer never opened a second GET stream: the stream carried no id.
      expect(
        opened.fixture.seen.filter((event) => event.method === 'GET').length,
      ).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('holds a POST that waits for its headers in its slot', async () => {
    const opened = await open({ withholdPosts: true });
    let settled = 0;
    try {
      opened.session.beginOperation();
      // The notification stream of the session is open.
      await until(() =>
        opened.fixture.seen.some((event) => event.method === 'GET'),
      );
      // The server asks four questions: every answer is a POST that never
      // gets its headers.
      for (let index = 0; index < 4; index++)
        opened.fixture.push(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 900 + index,
            method: 'ping',
          })}\n\n`,
        );
      // Four more requests of the client wait for a slot.
      const pings = [0, 1, 2, 3].map(() =>
        call(opened.client, 30_000).then(
          () => {
            settled += 1;
          },
          () => undefined,
        ),
      );
      // The four slots are the limit: no fifth POST connection is open.
      await until(() => opened.fixture.openPosts() === 4);
      expect(opened.fixture.openPosts()).toBe(4);
      expect(opened.fixture.peakPosts()).toBeLessThanOrEqual(4);
      // Every open POST holds a socket of its own.
      expect(opened.fixture.openConnections()).toBe(5);
      // The end of the operation closes every open POST connection.
      opened.session.endOperation();
      await until(() => opened.fixture.closedPosts() >= 4);
      expect(opened.deaths()).toBe(0);
      // The four requests of the client never reached the peer.
      expect(settled).toBe(0);
      expect(pings).toHaveLength(4);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('admits a queued POST only after a slot frees', async () => {
    const opened = await open({ withholdPosts: true });
    let settled = 0;
    try {
      opened.session.beginOperation();
      // Four requests hold the four slots.
      const held = [0, 1, 2, 3].map(() =>
        call(opened.client, 30_000).then(
          () => {
            settled += 1;
          },
          () => undefined,
        ),
      );
      await until(() => opened.fixture.openPosts() === 4);
      const posts = opened.fixture.seen.filter(
        (event) => event.method === 'POST',
      ).length;
      // The fifth request waits for a slot that never frees: the peer sees
      // no other POST.
      void call(opened.client, 30_000).catch(() => undefined);
      await until(() => opened.session.inspect().queued === 1);
      expect(opened.fixture.openPosts()).toBe(4);
      // The fifth request never reached the peer.
      expect(
        opened.fixture.seen.filter((event) => event.method === 'POST').length,
      ).toBe(posts);
      // The end of the operation closes the open POSTs: the queued request
      // is admitted with the slot that frees.
      opened.session.endOperation();
      await until(
        () =>
          opened.fixture.seen.filter((event) => event.method === 'POST')
            .length ===
          posts + 1,
      );
      // The four requests that held the slots never reached the peer.
      expect(settled).toBe(0);
      expect(held).toHaveLength(4);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('fails a queued POST when the peer dies', async () => {
    const opened = await open({ withholdPosts: true });
    try {
      opened.session.beginOperation();
      // Four requests hold the four slots.
      const held = [0, 1, 2, 3].map(() =>
        call(opened.client, 30_000).catch(() => undefined),
      );
      await until(() => opened.fixture.openPosts() === 4);
      // The fifth request waits for a slot that never frees.
      const queued = call(opened.client, 30_000);
      // The request waits: the peer sees no other POST.
      await until(() => opened.session.inspect().queued === 1);
      expect(opened.fixture.openPosts()).toBe(4);
      // The lifetime of the peer ends: the queued request fails with it.
      opened.controller.abort();
      await expect(queued).rejects.toMatchObject({ reason: 'cancelled' });
      await Promise.all(held);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('fails a queued POST with a timeout when no slot frees', async () => {
    const opened = await open({ withholdPosts: true });
    try {
      opened.session.beginOperation();
      const held = [0, 1, 2, 3].map(() =>
        call(opened.client, 30_000).catch(() => undefined),
      );
      await until(() => opened.fixture.openPosts() === 4);
      const queued = call(opened.client, 30_000);
      // The request waits: the peer sees no other POST.
      await until(() => opened.session.inspect().queued === 1);
      expect(opened.fixture.openPosts()).toBe(4);
      opened.controller.abort(
        new DOMException('The operation timed out.', 'TimeoutError'),
      );
      await expect(queued).rejects.toMatchObject({ reason: 'timed_out' });
      await Promise.all(held);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('dies when an established GET notification stream ends', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (event.method === 'GET') {
          event.response.writeHead(200, {
            'content-type': 'text/event-stream',
          });
          event.response.flushHeaders();
          return;
        }
        const message = event.messages[0];
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        if (message.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        // The answer of the request comes over the GET stream; the POST
        // itself never answers.
        const id = message.id;
        setTimeout(() => {
          fixture.push(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                tools: [
                  { name: 'fixture_first', inputSchema: { type: 'object' } },
                ],
              },
            })}\n\n`,
          );
          // The notification stream ends after the answer was delivered.
          fixture.closeStreams();
        }, 50);
      };
    });
    try {
      opened.session.beginOperation();
      expect(await list(opened.client, 5000)).toMatchObject({
        tools: [{ name: 'fixture_first' }],
      });
      // The SDK treats the end of the stream as a normal end once a response
      // was delivered over it: the hub does not.
      await until(() => opened.deaths() === 1);
      expect(opened.deaths()).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('frames a GET stream as SSE whatever its content type', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (event.method === 'GET') {
          // The peer declares a plain body but speaks SSE over it.
          event.response.writeHead(200, { 'content-type': 'text/plain' });
          event.response.flushHeaders();
          return;
        }
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        jsonAnswer(event, fixture.options);
      };
    });
    try {
      opened.session.beginOperation();
      await list(opened.client);
      // The notifications are SSE events in a body that is not declared as
      // one: the hub frames the stream by its role, so it counts them.
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      });
      opened.fixture.push(`data: ${notification}\n\n`.repeat(601));
      await expect(
        Promise.race([list(opened.client, 3000), opened.death]),
      ).rejects.toBeDefined();
      expect(opened.deaths()).toBeGreaterThan(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('dies when a GET stream declared as text/plain ends', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (event.method === 'GET') {
          // The peer declares a plain body but speaks SSE over it.
          event.response.writeHead(200, { 'content-type': 'text/plain' });
          event.response.flushHeaders();
          return;
        }
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        // The POST answers with the headers of an event stream and stays
        // open: the answer of the request comes over the GET stream.
        const id = message.id;
        event.response.writeHead(200, {
          'content-type': 'text/event-stream',
          'mcp-session-id': 'synthetic-session',
        });
        event.response.flushHeaders();
        setTimeout(() => {
          fixture.push(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                tools: [
                  { name: 'fixture_first', inputSchema: { type: 'object' } },
                ],
              },
            })}\n\n`,
          );
          // The notification stream ends after the answer was delivered.
          fixture.closeStreams();
        }, 50);
      };
    });
    try {
      opened.session.beginOperation();
      expect(await list(opened.client, 5000)).toMatchObject({
        tools: [{ name: 'fixture_first' }],
      });
      // The stream was established: its end is the end of the peer.
      await until(() => opened.deaths() === 1);
      expect(opened.deaths()).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('does not die when the peer refuses the GET stream', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (event.method === 'GET') {
          // The peer offers no notification stream.
          event.response.writeHead(405, {
            'content-type': 'text/event-stream',
          });
          event.response.end();
          return;
        }
        jsonAnswer(event, fixture.options);
      };
    });
    try {
      opened.session.beginOperation();
      expect(await list(opened.client)).toMatchObject({
        tools: [{ name: 'fixture_first' }],
      });
      opened.session.endOperation();
      // The peer refused the notification stream: the session knows it.
      await until(() => opened.session.inspect().refused === 1);
      // A refused GET never was a notification stream: the peer is alive.
      expect(opened.deaths()).toBe(0);
      expect(opened.errors()).toHaveLength(0);
      opened.session.beginOperation();
      expect(await call(opened.client)).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('sends the DELETE on dispose and closes every connection first', async () => {
    const opened = await open();
    const started = Date.now();
    await opened.session.dispose();
    expect(Date.now() - started).toBeLessThan(7000);
    expect(opened.fixture.seen.some((event) => event.method === 'DELETE')).toBe(
      true,
    );
    // Every connection is closed before any other cleanup runs.
    await until(() => opened.fixture.openConnections() === 0);
    await opened.client.close();
    await opened.fixture.close();

    const refused = await open({ deleteStatus: 405 });
    const refusedStarted = Date.now();
    await refused.session.dispose();
    expect(Date.now() - refusedStarted).toBeLessThan(7000);
    expect(
      refused.fixture.seen.some((event) => event.method === 'DELETE'),
    ).toBe(true);
    await until(() => refused.fixture.openConnections() === 0);
    await refused.client.close();
    await refused.fixture.close();

    const stalled = await open({ deleteStalls: true });
    const stalledStarted = Date.now();
    await stalled.session.dispose();
    // The DELETE is bounded to five seconds.
    expect(Date.now() - stalledStarted).toBeLessThan(7000);
    await until(() => stalled.fixture.openConnections() === 0);
    await stalled.client.close();
    await stalled.fixture.close();

    // The DELETE sends its headers and stalls its body: the socket timeout
    // covers the headers only, so the dedicated bound of five seconds ends
    // the termination.
    const stalledBody = await open({ deleteStallsBody: true });
    const stalledBodyStarted = Date.now();
    await stalledBody.session.dispose();
    expect(Date.now() - stalledBodyStarted).toBeLessThan(7000);
    expect(
      stalledBody.fixture.seen.some((event) => event.method === 'DELETE'),
    ).toBe(true);
    await until(() => stalledBody.fixture.openConnections() === 0);
    await stalledBody.client.close();
    await stalledBody.fixture.close();
  }, 40_000);

  it('disposes a session with a quiet GET stream without an error', async () => {
    const opened = await open();
    try {
      // The notification stream of the session is open and quiet.
      await until(() => opened.session.inspect().streams === 1);
      await opened.session.dispose();
      // The teardown of the session is not a failure of the peer.
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('disposes while a POST awaits its headers', async () => {
    const opened = await open({ withholdPosts: true });
    try {
      opened.session.beginOperation();
      // The notification stream of the session is open.
      await until(() => opened.session.inspect().streams === 1);
      // The request of the client never gets its headers.
      void call(opened.client, 30_000).catch(() => undefined);
      await until(() => opened.fixture.openPosts() === 1);
      const started = Date.now();
      await opened.session.dispose();
      // The teardown of the session is bounded.
      expect(Date.now() - started).toBeLessThan(7000);
      // The teardown of the session is not a failure of the peer.
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
      // The open POST is completed and its slot is released.
      expect(opened.session.inspect().posts).toBe(0);
      await until(() => opened.fixture.openPosts() === 0);
      expect(opened.fixture.openPosts()).toBe(0);
      // The peer never saw a second GET stream.
      expect(
        opened.fixture.seen.filter((event) => event.method === 'GET').length,
      ).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('disposes while replies of the session wait for a slot', async () => {
    const opened = await open({ withholdPosts: true });
    try {
      opened.session.beginOperation();
      // The notification stream of the session is open.
      await until(() =>
        opened.fixture.seen.some((event) => event.method === 'GET'),
      );
      // The server asks five questions: four answers hold the four slots
      // without headers and the fifth waits for a slot.
      for (let index = 0; index < 5; index++)
        opened.fixture.push(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 900 + index,
            method: 'ping',
          })}\n\n`,
        );
      await until(() => opened.session.inspect().queued === 1);
      // The four held replies reach the server; the fifth never does.
      await until(() => opened.fixture.openPosts() === 4);
      const started = Date.now();
      await opened.session.dispose();
      expect(Date.now() - started).toBeLessThan(7000);
      // The refused reply is no failure of the peer.
      await until(() => opened.fixture.openPosts() === 0);
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
      expect(opened.session.inspect()).toMatchObject({ posts: 0, queued: 0 });
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('disposes while a JSON POST body is incomplete', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (event.method === 'GET') {
          event.response.writeHead(200, {
            'content-type': 'text/event-stream',
          });
          event.response.flushHeaders();
          return;
        }
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        // The headers of the JSON answer arrive; its body never does.
        event.response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'synthetic-session',
        });
        event.response.flushHeaders();
      };
    });
    try {
      opened.session.beginOperation();
      // The notification stream of the session is open.
      await until(() => opened.session.inspect().streams === 1);
      // The answer of the request never arrives.
      void list(opened.client, 30_000).catch(() => undefined);
      // The client holds the JSON body: its headers arrived.
      await until(() => opened.session.inspect().bodies === 2);
      const started = Date.now();
      await opened.session.dispose();
      // The teardown of the session is bounded.
      expect(Date.now() - started).toBeLessThan(7000);
      // The teardown of the session is not a failure of the peer.
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
      // The open POST is completed and its slot is released.
      expect(opened.session.inspect().posts).toBe(0);
      await until(() => opened.fixture.openPosts() === 0);
      expect(opened.fixture.openPosts()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('disposes after the lifetime aborted with a stalled DELETE', async () => {
    const opened = await open({ deleteStalls: true });
    try {
      // The notification stream of the session is open and quiet.
      await until(() => opened.session.inspect().streams === 1);
      // The lifetime of the peer ends: the session is abandoned.
      opened.controller.abort();
      const started = Date.now();
      await opened.session.dispose();
      // The termination of the session is bounded to five seconds.
      expect(Date.now() - started).toBeLessThan(7000);
      // The teardown of the session is not a failure of the peer.
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
      // No POST is open and no slot is held.
      expect(opened.session.inspect().posts).toBe(0);
      expect(opened.fixture.openPosts()).toBe(0);
      // The peer never saw a second GET stream.
      expect(
        opened.fixture.seen.filter((event) => event.method === 'GET').length,
      ).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  }, 30_000);

  it('reports a breach that happened just before the dispose', async () => {
    const opened = await open();
    try {
      opened.session.beginOperation();
      await list(opened.client);
      // The peer sends an event that never ends.
      const incomplete = 'data: ' + 'x'.repeat(100 * 1024);
      opened.fixture.push(incomplete);
      await read(opened, incomplete.length);
      // The operation ends: the incomplete event breaches the budget of the
      // window between two operations.
      opened.session.endOperation();
      expect(opened.deaths()).toBe(1);
      await opened.session.dispose();
      // The teardown of the session is no second death.
      expect(opened.deaths()).toBe(1);
      expect(opened.errors()).toHaveLength(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('keeps no record of finished POST bodies', async () => {
    let answers = 0;
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (keepStreamOpen(event)) return;
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        // Every second answer is a JSON body, the others an SSE stream that
        // stays open.
        answers += 1;
        if (answers % 2 === 0) jsonAnswer(event, fixture.options);
        else sseAnswer(event, fixture.options, true);
      };
    });
    try {
      for (let index = 0; index < 20; index++) {
        opened.session.beginOperation();
        expect(await call(opened.client)).toMatchObject({
          content: [{ text: 'synthetic success' }],
        });
        opened.session.endOperation();
      }
      // Twenty SSE answers and twenty JSON answers left no record of their
      // own: only the notification stream of the session is open.
      await until(() => opened.session.inspect().streams === 1);
      expect(opened.session.inspect().bodies).toBe(1);
      await opened.session.dispose();
      await until(() => opened.session.inspect().bodies === 0);
      expect(opened.session.inspect().bodies).toBe(0);
      expect(opened.deaths()).toBe(0);
      expect(opened.errors()).toHaveLength(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('bounds the termination of a DELETE that trickles its headers', async () => {
    const opened = await open({ deleteTrickle: true });
    try {
      // The notification stream of the session is open and quiet.
      await until(() => opened.session.inspect().streams === 1);
      const started = Date.now();
      await opened.session.dispose();
      // The socket of the DELETE stays busy, so its inactivity timeout never
      // fires: only the dedicated bound of five seconds ends the termination.
      expect(Date.now() - started).toBeLessThan(7000);
      expect(
        opened.fixture.seen.some((event) => event.method === 'DELETE'),
      ).toBe(true);
      await until(() => opened.fixture.openConnections() === 0);
      expect(opened.fixture.openConnections()).toBe(0);
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  }, 30_000);

  it('dies when the legacy SSE main stream ends', async () => {
    const opened = await open({}, undefined, 'sse');
    try {
      expect(opened.deaths()).toBe(0);
      opened.fixture.closeStreams();
      await until(() => opened.deaths() === 1);
      expect(opened.deaths()).toBe(1);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('ends a POST stream the server keeps open and serves the next operation', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => sseAnswer(event, fixture.options, true);
    });
    try {
      const deadline = new AbortController();
      opened.session.beginOperation();
      expect(
        await opened.client.request(
          {
            method: 'tools/call',
            params: { name: 'fixture_first', arguments: {} },
          },
          CallToolResultSchema,
          { signal: deadline.signal, timeout: 5000 },
        ),
      ).toMatchObject({ content: [{ text: 'synthetic success' }] });
      opened.session.endOperation();
      // The body was ended: the fixture sees no open POST connection.
      await until(() => opened.fixture.openPosts() === 0);
      expect(opened.fixture.openPosts()).toBe(0);
      // A second operation succeeds.
      opened.session.beginOperation();
      expect(await call(opened.client)).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      opened.session.endOperation();
      const sent = opened.session.inspect().sent;
      // The deadline of the first operation passes later: it has no effect.
      deadline.abort();
      // The client sends the cancellation of the finished request: the peer
      // is still alive.
      await until(() => opened.session.inspect().sent > sent);
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('completes an open JSON POST without killing the session', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (event.method === 'GET') {
          event.response.writeHead(200, {
            'content-type': 'text/event-stream',
          });
          event.response.flushHeaders();
          return;
        }
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        // The POST sends the headers of a JSON answer and stays open: the
        // result arrives over the notification stream.
        const id = message.id;
        const result = sessionResult(message, fixture.options);
        event.response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'synthetic-session',
        });
        event.response.flushHeaders();
        setTimeout(() => {
          fixture.push(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id,
              result,
            })}\n\n`,
          );
        }, 50);
      };
    });
    try {
      opened.session.beginOperation();
      expect(await list(opened.client, 5000)).toMatchObject({
        tools: [{ name: 'fixture_first' }],
      });
      // The operation ends: the open JSON body is completed on purpose and
      // the session survives it.
      opened.session.endOperation();
      await until(() => opened.fixture.openPosts() === 0);
      expect(opened.deaths()).toBe(0);
      expect(opened.errors()).toHaveLength(0);
      // The next operation succeeds.
      opened.session.beginOperation();
      expect(await call(opened.client, 5000)).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('keeps the session alive with event ids on a result response', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) =>
        sseAnswer(event, fixture.options, true, true);
    });
    try {
      const closed = opened.fixture.closedPosts();
      opened.session.beginOperation();
      expect(await call(opened.client)).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      opened.session.endOperation();
      // The client closed the POST connection itself.
      await until(() => opened.fixture.closedPosts() > closed);
      expect(opened.fixture.closedPosts()).toBeGreaterThan(closed);
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
      // The peer never resumed the stream with a second GET.
      expect(
        opened.fixture.seen.filter((event) => event.method === 'GET').length,
      ).toBe(1);
      // The next operation succeeds.
      opened.session.beginOperation();
      expect(await call(opened.client)).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('keeps the session alive with event ids on an error response', async () => {
    let answers = 0;
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => {
        if (keepStreamOpen(event)) return;
        const message = event.messages[0];
        if (message?.method === 'initialize') {
          jsonAnswer(event, fixture.options);
          return;
        }
        // The first answer is a JSON-RPC error, the next one a result.
        if (!message || message.id === undefined) {
          event.response.writeHead(202);
          event.response.end();
          return;
        }
        answers += 1;
        sseAnswer(event, fixture.options, true, true, answers === 1);
      };
    });
    try {
      const closed = opened.fixture.closedPosts();
      opened.session.beginOperation();
      await expect(call(opened.client)).rejects.toBeDefined();
      opened.session.endOperation();
      await until(() => opened.fixture.closedPosts() > closed);
      expect(opened.fixture.closedPosts()).toBeGreaterThan(closed);
      expect(opened.errors()).toHaveLength(0);
      expect(opened.deaths()).toBe(0);
      expect(
        opened.fixture.seen.filter((event) => event.method === 'GET').length,
      ).toBe(1);
      // The next operation succeeds.
      opened.session.beginOperation();
      expect(await call(opened.client)).toMatchObject({
        content: [{ text: 'synthetic success' }],
      });
      opened.session.endOperation();
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('closes every POST connection over 50 operations', async () => {
    const opened = await open({}, (fixture) => {
      fixture.handler = (event) => sseAnswer(event, fixture.options, true);
    });
    try {
      for (let index = 0; index < 50; index++) {
        opened.session.beginOperation();
        expect(await call(opened.client)).toMatchObject({
          content: [{ text: 'synthetic success' }],
        });
        opened.session.endOperation();
      }
      await until(() => opened.fixture.openPosts() === 0);
      expect(opened.fixture.openPosts()).toBe(0);
      expect(opened.fixture.peakPosts()).toBeLessThanOrEqual(4);
      expect(opened.deaths()).toBe(0);
    } finally {
      await opened.client.close();
      await opened.fixture.close();
    }
  });

  it('terminates the remote session when the handshake fails', async () => {
    const fixture = await mcpSessionFixture({ badProtocol: true });
    const client = new Client(
      { name: 'synthetic-session-client', version: '1' },
      { capabilities: {} },
    );
    const remote = {
      ...syntheticConnector('connector-0', 'remote'),
      endpoint: `${fixture.origin}/mcp`,
      transport: 'streamable_http',
    } as Extract<Connector, { executionMode: 'remote' }>;
    try {
      // The peer issues a session id and then refuses the protocol version:
      // the handshake fails.
      await expect(
        remoteSessionPeer(
          client,
          remote,
          new AbortController().signal,
          () => undefined,
          undefined,
          fixture.origin,
        ),
      ).rejects.toBeDefined();
      // The remote session is terminated instead of stranded.
      expect(fixture.seen.some((event) => event.method === 'DELETE')).toBe(
        true,
      );
      await until(() => fixture.openConnections() === 0);
      expect(fixture.openConnections()).toBe(0);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('keeps the plain transport counters unchanged', async () => {
    const fixture = await mcpSessionFixture();
    try {
      const fetch = restrictedFetch(
        `${fixture.origin}/mcp`,
        new AbortController().signal,
        fixture.origin,
      );
      for (let index = 0; index < 64; index++)
        await fetch(`${fixture.origin}/mcp`, {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: index, method: 'ping' }),
        });
      // The sixty-fifth request of the lifetime is refused.
      await expect(
        fetch(`${fixture.origin}/mcp`, { method: 'POST', body: '{}' }),
      ).rejects.toHaveProperty('reason', 'limit_exceeded');
    } finally {
      await fixture.close();
    }
  });

  it('keeps the plain response byte allowance unchanged', async () => {
    const fixture = await mcpSessionFixture({ catalogBytes: 1024 * 1024 + 16 });
    try {
      const fetch = restrictedFetch(
        `${fixture.origin}/mcp`,
        new AbortController().signal,
        fixture.origin,
      );
      const response = await fetch(`${fixture.origin}/mcp`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      await expect(response.json()).rejects.toBeDefined();
    } finally {
      await fixture.close();
    }
  });
});
