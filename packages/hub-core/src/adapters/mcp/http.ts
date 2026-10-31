import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type {
  Transport,
  FetchLike,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { RuntimeFault } from '../../runtime/capabilities.js';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  // Reject transition/documentation ranges as well as local IPv6; a 6to4
  // address can embed a private IPv4 destination behind an apparent public IP.
  return (
    isIP(address) === 6 &&
    /^[23]/.test(address) &&
    !/^(?:2001:|2002:|3ff[ef]:)/i.test(address)
  );
}

// The session budgets of the spec: one operation, the whole session and the
// window between two operations.
const OPERATION_REQUESTS = 64;
const SESSION_REQUESTS = 4096;
const IDLE_REQUESTS = 32;
const OPERATION_BYTES = 1024 * 1024;
const SESSION_BYTES = 64 * 1024 * 1024;
const IDLE_BYTES = 64 * 1024;
const OPERATION_MESSAGES = 512;
const SESSION_MESSAGES = 32_768;
const IDLE_MESSAGES = 32;
// One received message, one event's data and the pending buffer of a stream.
const MESSAGE_BYTES = 1024 * 1024;
// The request body of one POST.
const REQUEST_BYTES = 32 * 1024;
// The open POST bodies of one session.
const MAX_POSTS = 4;
// The termination of a session is bounded.
const TERMINATE_MS = 5000;

interface Address {
  address: string;
  family: number;
}

// The destination checks of one request. They never change with the session
// mode: origin, https, a public address, no redirects, a header allow-list,
// credential headers from the binding resolver only and a bounded body.
function checkOrigin(
  url: URL,
  origin: string,
  fixtureOrigin: string | undefined,
) {
  const fixture =
    fixtureOrigin === origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    (!fixture && url.protocol !== 'https:')
  )
    throw new RuntimeFault('destination_denied');
  return fixture;
}

async function resolveAddresses(
  url: URL,
  fixture: boolean,
  signal: AbortSignal,
): Promise<Address[]> {
  if (fixture) return [{ address: '127.0.0.1', family: 4 }];
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  return new Promise<Address[]>((resolve, reject) => {
    const abort = () => reject(new RuntimeFault('destination_denied'));
    if (dnsSignal.aborted) {
      abort();
      return;
    }
    dnsSignal.addEventListener('abort', abort, { once: true });
    lookup(url.hostname, { all: true, verbatim: true })
      .then(resolve, () => reject(new RuntimeFault('destination_denied')))
      .finally(() => dnsSignal.removeEventListener('abort', abort));
  });
}

function buildHeaders(
  init: RequestInit,
  credentials: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    if (
      ![
        'accept',
        'content-type',
        'mcp-session-id',
        'mcp-protocol-version',
        'last-event-id',
      ].includes(key) ||
      value.length > 2048
    )
      throw new RuntimeFault('protocol_error');
    headers[key] = value;
  });
  // Only the binding resolver may supply credential headers. SDK/server input
  // cannot add Authorization/Cookie. Never follow redirects with these values.
  for (const [key, value] of Object.entries(credentials)) {
    if (
      !/^(?:Authorization|X-[a-z0-9-]+|Api-Key)$/i.test(key) ||
      /[\r\n\0]/.test(value) ||
      value.length > 8192
    )
      throw new RuntimeFault('secrets_pending');
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

function checkRequestBody(init: RequestInit) {
  if (
    init.body !== undefined &&
    init.body !== null &&
    (typeof init.body !== 'string' ||
      Buffer.byteLength(init.body, 'utf8') > REQUEST_BYTES)
  )
    throw new RuntimeFault('limit_exceeded');
}

interface SecureResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

// The request itself. The body factory runs while the response headers are
// in hand, so the caller owns the body from its first byte. The owner of the
// request may settle it with a synthetic answer before its headers arrive:
// a request the session closes itself is never a failure of the peer.
function sendSecure(
  url: URL,
  init: RequestInit,
  headers: Record<string, string>,
  addresses: Address[],
  fixture: boolean,
  signal: AbortSignal,
  makeBody: (
    response: IncomingMessage,
    request: ClientRequest,
  ) => ReadableStream<Uint8Array>,
  onRequest?: (
    request: ClientRequest,
    settle: (response: SecureResponse) => void,
  ) => void,
  onHeaders?: (request: ClientRequest) => void,
): Promise<SecureResponse> {
  return new Promise<SecureResponse>((resolve, reject) => {
    let settled = false;
    const settle = (response: SecureResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = (fixture ? httpRequest : httpsRequest)(
      url,
      {
        method: init.method ?? 'GET',
        headers,
        signal,
        timeout: 5000,
        agent: false,
        rejectUnauthorized: true,
        lookup: (_hostname, options, callback) => {
          const first = addresses[0]!;
          if (options.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          response.destroy();
          fail(new RuntimeFault('destination_denied'));
          return;
        }
        if (status === 401 || status === 403) {
          response.destroy();
          fail(new RuntimeFault('auth_required'));
          return;
        }
        const resultHeaders = new Headers();
        for (const key of [
          'content-type',
          'mcp-session-id',
          'mcp-protocol-version',
        ]) {
          const value = response.headers[key];
          if (typeof value === 'string' && value.length <= 2048)
            resultHeaders.set(key, value);
        }
        onHeaders?.(request);
        const body = makeBody(response, request);
        settle({
          status,
          headers: resultHeaders,
          body: [204, 205, 304].includes(status) ? null : body,
        });
      },
    );
    // The owner of the request knows it from its first byte, before any
    // header arrives.
    onRequest?.(request, settle);
    request.once('timeout', () =>
      request.destroy(new RuntimeFault('timed_out')),
    );
    request.once('error', (error) =>
      fail(
        error instanceof RuntimeFault
          ? error
          : new RuntimeFault(
              signal.aborted ? 'cancelled' : 'dependency_unavailable',
            ),
      ),
    );
    request.end(typeof init.body === 'string' ? init.body : undefined);
  });
}

// A local fixture origin is a construction-time testing exception, never browser
// input or a global allow-private switch. Production only creates the default.
export function restrictedFetch(
  endpoint: string,
  signal: AbortSignal,
  fixtureOrigin?: string,
  credentials: Record<string, string> = {},
): FetchLike {
  const origin = new URL(endpoint).origin;
  let bytes = 0,
    requests = 0;
  const secureFetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    if (++requests > 64) throw new RuntimeFault('limit_exceeded');
    const fixture = checkOrigin(url, origin, fixtureOrigin);
    const addresses = await resolveAddresses(url, fixture, signal);
    if (
      !addresses.length ||
      (!fixture && addresses.some((item) => !publicAddress(item.address)))
    )
      throw new RuntimeFault('destination_denied');
    const headers = buildHeaders(init, credentials);
    checkRequestBody(init);
    const requestSignal = init.signal
      ? AbortSignal.any([signal, init.signal])
      : signal;
    const result = await sendSecure(
      url,
      init,
      headers,
      addresses,
      fixture,
      requestSignal,
      (response, request) => {
        let ended = false;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            response.on('data', (chunk: Buffer) => {
              if (ended) return;
              bytes += chunk.length;
              if (bytes > 1024 * 1024) {
                ended = true;
                controller.error(new RuntimeFault('limit_exceeded'));
                response.destroy();
                return;
              }
              controller.enqueue(new Uint8Array(chunk));
            });
            response.once('end', () => {
              if (!ended) {
                ended = true;
                controller.close();
              }
            });
            response.once('error', () => {
              if (!ended) {
                ended = true;
                controller.error(new RuntimeFault('protocol_error'));
              }
            });
            response.once('close', () => {
              if (!ended) {
                ended = true;
                controller.error(new RuntimeFault('protocol_error'));
              }
            });
          },
          cancel() {
            ended = true;
            response.destroy();
            request.destroy();
          },
        });
      },
    );
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
  return secureFetch;
}
export function safeMcpHttpTransport(
  endpoint: string,
  transport: 'streamable_http' | 'sse',
  signal: AbortSignal,
  fixtureOrigin?: string,
  credentials: Record<string, string> = {},
): Transport {
  const secureFetch = restrictedFetch(
    endpoint,
    signal,
    fixtureOrigin,
    credentials,
  );
  return transport === 'sse'
    ? new SSEClientTransport(new URL(endpoint), {
        fetch: secureFetch,
        requestInit: { redirect: 'error' },
      })
    : new StreamableHTTPClientTransport(new URL(endpoint), {
        fetch: secureFetch,
        requestInit: { redirect: 'error' },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1,
          maxReconnectionDelay: 1,
          reconnectionDelayGrowFactor: 1,
        },
      });
}

// The counters of the session mode: one operation, the whole session and the
// window between two operations.
class SessionBudgets {
  private readonly total = { requests: 0, bytes: 0, received: 0, sent: 0 };
  private readonly operation = { requests: 0, bytes: 0, received: 0, sent: 0 };
  private readonly idle = { requests: 0, bytes: 0, received: 0, sent: 0 };
  private open = false;
  // The identity of the window that is open, or of the one between two
  // operations. Every window charges its own bytes.
  private identity = 0;

  // Opens the operation window: it reports whether a new window opened.
  beginOperation(): boolean {
    if (this.open) return false;
    this.open = true;
    this.identity += 1;
    this.operation.requests = 0;
    this.operation.bytes = 0;
    this.operation.received = 0;
    this.operation.sent = 0;
    return true;
  }

  endOperation() {
    if (!this.open) return;
    this.open = false;
    this.identity += 1;
    this.idle.requests = 0;
    this.idle.bytes = 0;
    this.idle.received = 0;
    this.idle.sent = 0;
  }

  // The identity of the current window.
  get window() {
    return this.identity;
  }

  // The window that is open, or the one between two operations.
  private get counters() {
    return this.open ? this.operation : this.idle;
  }

  countRequest() {
    this.total.requests += 1;
    this.counters.requests += 1;
    return (
      this.total.requests <= SESSION_REQUESTS &&
      this.counters.requests <= (this.open ? OPERATION_REQUESTS : IDLE_REQUESTS)
    );
  }

  countBytes(count: number) {
    this.total.bytes += count;
    this.counters.bytes += count;
    return (
      this.total.bytes <= SESSION_BYTES &&
      this.counters.bytes <= (this.open ? OPERATION_BYTES : IDLE_BYTES)
    );
  }

  countReceived(count = 1) {
    this.total.received += count;
    this.counters.received += count;
    return (
      this.total.received <= SESSION_MESSAGES &&
      this.counters.received <= (this.open ? OPERATION_MESSAGES : IDLE_MESSAGES)
    );
  }

  countSent(count = 1) {
    this.total.sent += count;
    this.counters.sent += count;
    return (
      this.total.sent <= SESSION_MESSAGES &&
      this.counters.sent <= (this.open ? OPERATION_MESSAGES : IDLE_MESSAGES)
    );
  }

  // The bytes of an event that is still incomplete when a window opens: the
  // new window charges them again, the whole session never does.
  countCarriedBytes(count: number) {
    this.counters.bytes += count;
    return this.counters.bytes <= (this.open ? OPERATION_BYTES : IDLE_BYTES);
  }
}

export interface SseSink {
  // The raw bytes of the response.
  bytes(count: number): void;
  // One line of the stream, forwarded unchanged.
  text(value: string): void;
  // One dispatched event with its joined data lines.
  event(data: string | undefined): void;
}

// The line ends of the SDK's SSE parser: CR, LF and CRLF. A CR at the end of
// a chunk and a LF at the start of the next chunk are one line end.
const CR = 13;
const LF = 10;

// The end of the first line of the buffer. A CR at the very end of the buffer
// may be the first half of a CRLF, so it waits for the next chunk.
function lineEnd(buffer: Buffer): { index: number; size: number } | undefined {
  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index]!;
    if (byte === LF) return { index, size: 1 };
    if (byte === CR) {
      if (index === buffer.length - 1) return undefined;
      return { index, size: buffer[index + 1] === LF ? 2 : 1 };
    }
  }
  return undefined;
}

// The pass-through SSE framer: it forwards the text, counts the events and
// caps the data of one event and the pending, undispatched buffer. The lines
// are split exactly like the SDK's parser splits them, so a CR-delimited
// stream is framed like an LF-delimited one.
export class SseFramer {
  // The raw bytes of the still-incomplete event, its partial line included.
  get pending() {
    return this.eventBytes + this.buffer.length;
  }
  // The raw bytes of the event that is open: its completed lines, counted
  // from the first byte of the event up to the end of the last one.
  private get eventBytes() {
    return this.consumed - this.dispatched;
  }
  // The window between two operations that charged these bytes already.
  chargedWindow = -1;
  private readonly decoder = new TextDecoder();
  // The bytes of the line that is not complete yet.
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  // The raw bytes of the complete lines and of the last dispatched event.
  private consumed = 0;
  private dispatched = 0;
  private dataLines: string[] = [];
  private dataBytes = 0;

  constructor(
    private readonly sink: SseSink,
    private readonly dropIds: boolean,
  ) {}

  push(chunk: Buffer) {
    this.sink.bytes(chunk.length);
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    for (;;) {
      const end = lineEnd(this.buffer);
      if (!end) break;
      const line = this.buffer.subarray(0, end.index);
      this.buffer = this.buffer.subarray(end.index + end.size);
      this.consumed += line.length + end.size;
      this.handle(this.decoder.decode(line));
      // The cap of the pending event: the bytes of the event that is open,
      // from its first byte up to the end of the line just consumed. The
      // events behind it in the same chunk never count against it.
      if (this.eventBytes > MESSAGE_BYTES)
        throw new RuntimeFault('limit_exceeded');
    }
    // The event that is still pending: its completed lines and the line that
    // never ends.
    if (this.pending > MESSAGE_BYTES) throw new RuntimeFault('limit_exceeded');
  }

  // The end of the stream discards an event that was never terminated.
  flush() {
    if (this.buffer.length) {
      this.sink.text(this.decoder.decode(this.buffer) + '\n');
      this.buffer = Buffer.alloc(0);
    }
    this.dataLines = [];
    this.dataBytes = 0;
  }

  private handle(line: string) {
    if (line === '') {
      // The blank line ends the event and is forwarded unchanged: the SDK
      // needs it to dispatch the event.
      this.sink.text('\n');
      this.dispatch();
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') {
      this.dataLines.push(value);
      this.dataBytes += Buffer.byteLength(value, 'utf8');
      // The data of one event is all its data lines joined.
      const joined = this.dataBytes + Math.max(0, this.dataLines.length - 1);
      if (joined > MESSAGE_BYTES) throw new RuntimeFault('limit_exceeded');
    }
    // The hub never resumes a POST response stream: its events carry no id.
    if (field === 'id' && this.dropIds) return;
    this.sink.text(line + '\n');
  }

  private dispatch() {
    const data = this.dataLines.length ? this.dataLines.join('\n') : undefined;
    this.dataLines = [];
    this.dataBytes = 0;
    this.dispatched = this.consumed;
    this.sink.event(data);
  }
}

// The open body of one POST, with the JSON-RPC request ids it carried.
interface PostSlot {
  ids: Set<string>;
  count: number;
  answered: Set<string>;
  request: ClientRequest | undefined;
  // The synthetic answer of a request that never got its headers.
  settle: ((response: SecureResponse) => void) | undefined;
  response: IncomingMessage | undefined;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  framer: SseFramer | undefined;
  // The record of the body of this POST: the completion removes it, so a
  // finished body keeps no record of its own.
  tracked: TrackedBody | undefined;
  // The intentional completion of the body: it ends the stream the SDK reads
  // the way its framing demands.
  complete: (() => void) | undefined;
  completed: boolean;
}

// The session of one remote peer: its transport, its windows and its end.
export interface RemoteSession {
  transport: Transport;
  // Opens the operation window; a window that is open stays open.
  beginOperation(): void;
  // Closes the operation window and completes the POST bodies still open.
  endOperation(): void;
  dispose(): Promise<void>;
  // The numbers of the session: the sizes and the counts only, never its
  // content.
  inspect(): RemoteSessionState;
}

// The numbers a test reads to know what the client saw. It carries no
// content: only the sizes and the counts of the session.
export interface RemoteSessionState {
  // The pending bytes of the framers: the events that are not dispatched.
  pendingBytes: number;
  // The requests that wait for a POST slot.
  queued: number;
  // The POST bodies that are open.
  posts: number;
  // The POST bodies the session opened.
  sent: number;
  // The SSE streams that are framed.
  streams: number;
  // The notification streams the peer refused.
  refused: number;
  // The records of the bodies that are open.
  bodies: number;
}

// A body stream of the session. The teardown of the session closes every
// body on purpose, so the errors of that teardown are the teardown's own
// and never the death of the peer.
interface TrackedBody {
  // The session closed this body on purpose.
  intentional: boolean;
}

// The session mode of the remote transport: one peer keeps its HTTP session,
// its budgets and its streams for the whole life of the pool entry.
class RemoteHttpSession {
  readonly transport: Transport;
  private readonly origin: string;
  private readonly endpoint: URL;
  private readonly internal = new AbortController();
  private readonly budgets = new SessionBudgets();
  private readonly posts = new Set<PostSlot>();
  private readonly bodies = new Set<TrackedBody>();
  private readonly waiting: Array<{
    resolve: (slot: PostSlot) => void;
    reject: (error: unknown) => void;
    detach: () => void;
  }> = [];
  private readonly framers = new Set<SseFramer>();
  private readonly encoder = new TextEncoder();
  private readonly inner: Transport;
  // The Streamable HTTP transport terminates its session; the legacy SSE
  // transport has no session to end.
  private readonly streamable: StreamableHTTPClientTransport | undefined;
  private readonly legacy: boolean;
  // The session id the peer issued; it terminates the remote session.
  private sessionId: string | undefined;
  // The protocol version the peer and the hub agreed on.
  private protocolVersion: string | undefined;
  private dead = false;
  private breached = false;
  private disposing = false;
  private disposed = false;
  // The teardown of the session closed its bodies on purpose.
  private closing = false;
  // The teardown of the session began: its errors reach nobody.
  private tearingDown = false;
  // The POST bodies the session opened.
  private sent = 0;
  // The notification streams the peer refused.
  private refused = 0;
  // The faults of the requests the end of an operation refused on purpose:
  // the SDK reports them as transport errors, and they are never the death
  // of the peer.
  private readonly refusals = new WeakSet<object>();

  constructor(
    endpoint: string,
    mode: 'streamable_http' | 'sse',
    private readonly signal: AbortSignal,
    private readonly died: () => void,
    private readonly credentials: Record<string, string>,
    private readonly fixtureOrigin: string | undefined,
  ) {
    this.endpoint = new URL(endpoint);
    this.origin = this.endpoint.origin;
    const fetch = this.secureFetch;
    this.legacy = mode === 'sse';
    this.streamable =
      mode === 'sse'
        ? undefined
        : new StreamableHTTPClientTransport(new URL(endpoint), {
            fetch,
            requestInit: { redirect: 'error' },
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1,
              maxReconnectionDelay: 1,
              reconnectionDelayGrowFactor: 1,
            },
          });
    this.inner =
      this.streamable ??
      new SSEClientTransport(new URL(endpoint), {
        fetch,
        requestInit: { redirect: 'error' },
      });
    const wrapper: Transport = {
      onmessage: undefined,
      onerror: undefined,
      onclose: undefined,
      setProtocolVersion: (version) => {
        this.protocolVersion = version;
        this.inner.setProtocolVersion?.(version);
      },
      start: () => this.inner.start(),
      // A send that fails once the teardown began is a request the hub
      // refused on purpose: closing the transport rejects every pending
      // request of the SDK, so nothing waits on it, and a reply the SDK
      // queued is never reported as a failure of the peer.
      send: async (message, options) => {
        try {
          await this.inner.send(message, options);
        } catch (error) {
          if (this.tearingDown) return;
          // An automatic reply or a notification that the end of an
          // operation refused on purpose is dropped: the SDK reports a failed
          // reply through `onerror`, which is the death of the peer. A
          // request still fails, so its caller learns it was cancelled.
          const request = 'method' in message && 'id' in message;
          if (!request && error instanceof Object && this.refusals.has(error))
            return;
          throw error;
        }
      },
      close: async () => {
        // The session is closing: the streams that end now are no death.
        this.disposing = true;
        // The teardown begins before anything is aborted: the open POSTs are
        // completed and the errors of the teardown are dropped.
        this.teardown();
        // The controller of the SDK is aborted before the streams end, so an
        // end that the SDK sees schedules no reconnection.
        await this.closeInner();
        this.internal.abort();
      },
    };
    this.inner.onmessage = (message, extra) =>
      wrapper.onmessage?.(message, extra);
    this.inner.onerror = (error) => {
      // The teardown of the session is not the failure of the peer: the
      // errors it causes are dropped, so the SDK never blames a session the
      // hub closed on purpose. An error that was seen before the teardown
      // began is still the death of the peer.
      if (this.tearingDown) return;
      if (this.refusals.has(error)) return;
      this.signalDeath();
      wrapper.onerror?.(error);
    };
    this.inner.onclose = () => {
      this.signalDeath();
      wrapper.onclose?.();
    };
    this.transport = wrapper;
  }

  beginOperation() {
    if (!this.budgets.beginOperation()) return;
    // An event that is still incomplete when the operation begins belongs
    // to the operation as well: its retained bytes count against the
    // operation budget, so a fragmented event never brings the allowance
    // of the window between two operations into it for free.
    this.chargePending();
  }

  // Every window charges the whole pending size of every incomplete event;
  // only the same window is never charged twice.
  private chargePending() {
    const window = this.budgets.window;
    for (const framer of [...this.framers]) {
      if (framer.chargedWindow === window) continue;
      framer.chargedWindow = window;
      if (!this.budgets.countCarriedBytes(framer.pending)) this.breach();
    }
  }

  // The numbers of the session: what the client holds and waits for. The
  // read carries no content, only sizes and counts.
  inspect(): RemoteSessionState {
    let pendingBytes = 0;
    for (const framer of this.framers) pendingBytes += framer.pending;
    return {
      pendingBytes,
      queued: this.waiting.length,
      posts: this.posts.size,
      sent: this.sent,
      streams: this.framers.size,
      refused: this.refused,
      bodies: this.bodies.size,
    };
  }

  endOperation() {
    this.budgets.endOperation();
    // An event that is still incomplete belongs to the window between two
    // operations.
    this.chargePending();
    // A request that still waits for a slot belongs to the operation that
    // ended: it fails before the open POSTs free their slots, so it never
    // opens a POST in the window between two operations.
    for (const waiter of this.waiting.splice(0)) {
      waiter.detach();
      const fault = new RuntimeFault('cancelled');
      this.refusals.add(fault);
      waiter.reject(fault);
    }
    // A POST body that is still open is completed the same way as a finished
    // one.
    for (const post of [...this.posts]) this.completePost(post);
  }

  // The termination of the session is best effort: a refusal, an error or a
  // timeout never blocks the local cleanup. The sequence is idempotent and
  // terminates the remote session before the signals of this session are
  // aborted, so it works whether or not the transport was closed before.
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposing = true;
    // The teardown begins before anything is aborted: the open POSTs are
    // completed and the errors of the teardown are dropped.
    this.teardown();
    // The controller of the SDK is aborted before the streams end, so an end
    // that the SDK sees schedules no reconnection.
    await this.closeInner();
    await this.terminateSession();
    this.internal.abort();
  }

  // The teardown of the session: every body that is still open is closed on
  // purpose, so the errors of the teardown are never the death of the peer.
  // A body that opens during the teardown is closed on purpose as well. The
  // open POSTs are completed before anything is aborted: the SDK reads a
  // well formed answer and the slots are released. The GET and the legacy
  // streams end later, when the controller of the SDK is aborted: the SDK
  // sees a normal end then and schedules no reconnection of its own.
  private teardown() {
    if (this.tearingDown) return;
    this.tearingDown = true;
    this.closing = true;
    for (const body of this.bodies) body.intentional = true;
    for (const post of [...this.posts]) this.completePost(post);
  }

  // The close of the inner transport. It aborts the controller of the SDK,
  // so a stream that ends after it is a normal end and the SDK schedules no
  // reconnection of its own.
  private async closeInner() {
    try {
      await this.inner.close();
    } catch {
      /* The session is closed locally either way. */
    }
  }

  // The DELETE that terminates the remote session. It carries a signal of its
  // own, so it still goes out when the transport was closed already.
  private async terminateSession() {
    if (!this.streamable) return;
    const id = this.sessionId;
    if (!id) return;
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), TERMINATE_MS);
    handle.unref?.();
    try {
      const response = await this.fetchSecure(
        this.endpoint,
        {
          method: 'DELETE',
          headers: {
            'mcp-session-id': id,
            ...(this.protocolVersion
              ? { 'mcp-protocol-version': this.protocolVersion }
              : {}),
          },
          signal: controller.signal,
        },
        true,
      );
      await response.body?.cancel();
    } catch {
      /* The session is closed locally either way. */
    } finally {
      clearTimeout(handle);
    }
  }

  // The signal of the requests: the peer's lifetime and the transport's own
  // close. The termination of a session outlives the peer's lifetime.
  private get effective(): AbortSignal {
    return this.disposing
      ? AbortSignal.any([this.internal.signal])
      : AbortSignal.any([this.signal, this.internal.signal]);
  }

  private signalDeath() {
    if (this.dead) return;
    this.dead = true;
    // A request that waits for a POST slot never gets one.
    for (const waiter of this.waiting.splice(0)) {
      waiter.detach();
      waiter.reject(new RuntimeFault('dependency_unavailable'));
    }
    // The teardown of the session is not the death of the peer: the caller
    // asked for it, so the pool is never told that the peer failed.
    if (this.disposing) return;
    this.died();
  }

  // One breach ends the session: the stream is errored, the peer is dead and
  // no further request is sent.
  private breach() {
    if (this.breached) return;
    this.breached = true;
    this.signalDeath();
  }

  // The end of an established notification stream is the end of the peer: the
  // SDK stops treating it as an error once a response was delivered over it.
  // A GET the peer refused never was a notification stream.
  private notificationEnded(method: string, established: boolean) {
    if (method !== 'GET') return;
    if (!established && !this.legacy) this.refused += 1;
    if (this.disposing || this.dead) return;
    if (!this.legacy && !established) return;
    this.signalDeath();
  }

  private readonly secureFetch: FetchLike = async (input, init = {}) =>
    this.fetchSecure(new URL(String(input)), init, false);

  // One request of the session. A standalone request (the DELETE that ends
  // the remote session) carries a signal of its own: the signals of this
  // session may be aborted already.
  private async fetchSecure(
    url: URL,
    init: RequestInit,
    standalone: boolean,
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    // The teardown of the session refuses every request but the termination
    // of the remote session: no new connection opens while it runs.
    if (this.tearingDown && method !== 'DELETE')
      throw new RuntimeFault('cancelled');
    // The termination of a session is never a breach and never a dead peer.
    if (this.breached && method !== 'DELETE')
      throw new RuntimeFault('limit_exceeded');
    if (this.dead && method !== 'DELETE')
      throw new RuntimeFault('dependency_unavailable');
    // The DELETE ends the session: it counts against no window.
    if (method !== 'DELETE' && !this.budgets.countRequest()) {
      this.breach();
      throw new RuntimeFault('limit_exceeded');
    }
    const requestSignal = standalone
      ? (init.signal ?? new AbortController().signal)
      : init.signal
        ? AbortSignal.any([this.effective, init.signal])
        : this.effective;
    const fixture = checkOrigin(url, this.origin, this.fixtureOrigin);
    const addresses = await resolveAddresses(url, fixture, requestSignal);
    if (
      !addresses.length ||
      (!fixture && addresses.some((item) => !publicAddress(item.address)))
    )
      throw new RuntimeFault('destination_denied');
    const headers = buildHeaders(init, this.credentials);
    checkRequestBody(init);
    const post = method === 'POST' ? await this.openPost(init) : undefined;
    if (post && !this.budgets.countSent(post.count)) {
      this.breach();
      this.releaseSlot(post);
      throw new RuntimeFault('limit_exceeded');
    }
    try {
      const result = await sendSecure(
        url,
        init,
        headers,
        addresses,
        fixture,
        requestSignal,
        (response, request) => this.makeBody(post, response, request, method),
        // The slot owns its request from its first byte: a request that waits
        // for its headers is still open.
        (request, settle) => {
          if (!post) return;
          post.request = request;
          post.settle = settle;
        },
        // The socket timeout covers the headers only; the streams that follow
        // are bounded by the idle life of the pool entry and the budgets. The
        // request itself is ended already, so the socket carries the timer.
        (request) => request.socket?.setTimeout(0),
      );
      // The session id the peer issued terminates the remote session.
      const sessionId = result.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;
      // A request that carries the session id and is refused has lost the
      // session: the peer is dead.
      if (result.status === 404 && headers['mcp-session-id'])
        this.signalDeath();
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    } catch (error) {
      if (post) this.completePost(post);
      throw error;
    }
  }

  // The body of one POST carries the JSON-RPC messages of the request.
  private async openPost(init: RequestInit): Promise<PostSlot> {
    const messages = parseMessages(
      typeof init.body === 'string' ? init.body : '',
    );
    const ids = new Set<string>();
    for (const message of messages)
      if (message.id !== undefined) ids.add(String(message.id));
    const slot = await this.acquireSlot(init.signal);
    slot.ids = ids;
    slot.count = messages.length;
    this.sent += 1;
    return slot;
  }

  // At most four POST bodies are open; a fifth request waits for a slot.
  private async acquireSlot(
    signal: AbortSignal | null | undefined,
  ): Promise<PostSlot> {
    if (this.posts.size < MAX_POSTS) return this.newSlot();
    const wait = AbortSignal.any(
      signal ? [signal, this.effective] : [this.effective],
    );
    return new Promise<PostSlot>((resolve, reject) => {
      const onAbort = () => {
        const reason = wait.reason;
        reject(
          new RuntimeFault(
            reason instanceof Error && reason.name === 'TimeoutError'
              ? 'timed_out'
              : 'cancelled',
          ),
        );
      };
      if (wait.aborted) {
        onAbort();
        return;
      }
      wait.addEventListener('abort', onAbort, { once: true });
      // The queue of the requests that wait for a slot. A cancelled request
      // is not released here: a cancelled or a timed out request ends its
      // peer in the bridge, so the waiters are never cancelled one by one.
      // They are admitted when a slot frees, and they fail when the operation
      // ends or when the session dies.
      this.waiting.push({
        resolve,
        reject,
        detach: () => wait.removeEventListener('abort', onAbort),
      });
    });
  }

  private newSlot(): PostSlot {
    const slot: PostSlot = {
      ids: new Set(),
      count: 0,
      answered: new Set(),
      request: undefined,
      settle: undefined,
      response: undefined,
      controller: undefined,
      framer: undefined,
      tracked: undefined,
      complete: undefined,
      completed: false,
    };
    this.posts.add(slot);
    return slot;
  }

  private releaseSlot(slot: PostSlot) {
    // A slot is never released while its request is still open.
    if (slot.request && !slot.request.destroyed) {
      try {
        slot.request.destroy();
      } catch {
        /* The request is gone either way. */
      }
    }
    if (!this.posts.delete(slot)) return;
    const next = this.waiting.shift();
    if (!next) return;
    next.detach();
    // The teardown of the session admits no new request: the waiting one
    // fails instead of opening a connection of its own.
    if (this.tearingDown) {
      next.reject(new RuntimeFault('cancelled'));
      return;
    }
    next.resolve(this.newSlot());
  }

  // The body of one response, framed before the SDK reads it.
  private makeBody(
    post: PostSlot | undefined,
    response: IncomingMessage,
    request: ClientRequest,
    method: string,
  ): ReadableStream<Uint8Array> {
    if (post) post.response = response;
    const essence = (response.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const status = response.statusCode ?? 500;
    // A notification stream the peer established ends with the peer: a GET
    // that was refused (405) never was one.
    const established = status >= 200 && status < 300;
    // The SDK parses every successful GET body as SSE, so the notification
    // stream of the session is framed as SSE whatever the peer declared.
    if (method === 'GET' && established)
      return this.sseBody(post, response, request, method, true);
    if (essence === 'text/event-stream')
      return this.sseBody(post, response, request, method, established);
    if (essence === 'application/json')
      return this.jsonBody(post, response, request);
    return this.plainBody(post, response, request);
  }

  // A JSON body is one message, or one message per element of an array.
  private jsonBody(
    post: PostSlot | undefined,
    response: IncomingMessage,
    request: ClientRequest,
  ): ReadableStream<Uint8Array> {
    const chunks: Buffer[] = [];
    let size = 0;
    let ended = false;
    const tracked: TrackedBody = { intentional: this.closing };
    this.bodies.add(tracked);
    if (post) post.tracked = tracked;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (post) {
          post.controller = controller;
          // The intentional completion of a JSON body: the SDK parses the body
          // of a JSON answer, so the body ends with an answer that holds no
          // message and raises no parse failure.
          post.complete = () => {
            if (ended) return;
            ended = true;
            try {
              controller.enqueue(this.encoder.encode('[]'));
            } catch {
              /* The stream is closed either way. */
            }
            try {
              controller.close();
            } catch {
              /* The stream is closed either way. */
            }
          };
        }
        response.on('data', (chunk: Buffer) => {
          if (ended) return;
          size += chunk.length;
          if (size > MESSAGE_BYTES || !this.budgets.countBytes(chunk.length)) {
            ended = true;
            this.breach();
            controller.error(new RuntimeFault('limit_exceeded'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          if (ended) return;
          ended = true;
          this.bodies.delete(tracked);
          const body = Buffer.concat(chunks);
          let messages = 1;
          try {
            const parsed = JSON.parse(body.toString('utf8')) as unknown;
            if (Array.isArray(parsed)) messages = parsed.length;
          } catch {
            messages = 1;
          }
          if (!this.budgets.countReceived(messages)) {
            this.breach();
            controller.error(new RuntimeFault('limit_exceeded'));
            response.destroy();
            return;
          }
          controller.enqueue(new Uint8Array(body));
          controller.close();
          if (post) this.completePost(post);
        });
        response.once('error', () => {
          if (ended) return;
          ended = true;
          this.bodies.delete(tracked);
          this.settleBody(controller, tracked);
        });
        response.once('close', () => {
          if (ended) return;
          ended = true;
          this.bodies.delete(tracked);
          this.settleBody(controller, tracked);
        });
      },
      cancel: () => {
        ended = true;
        this.bodies.delete(tracked);
        response.destroy();
        request.destroy();
        if (post) this.completePost(post);
      },
    });
  }

  // A body without a known framing: its bytes are counted, nothing else.
  private plainBody(
    post: PostSlot | undefined,
    response: IncomingMessage,
    request: ClientRequest,
  ): ReadableStream<Uint8Array> {
    let ended = false;
    const tracked: TrackedBody = { intentional: this.closing };
    this.bodies.add(tracked);
    if (post) post.tracked = tracked;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (post) post.controller = controller;
        response.on('data', (chunk: Buffer) => {
          if (ended) return;
          if (!this.budgets.countBytes(chunk.length)) {
            ended = true;
            this.breach();
            controller.error(new RuntimeFault('limit_exceeded'));
            response.destroy();
            return;
          }
          controller.enqueue(new Uint8Array(chunk));
        });
        response.once('end', () => {
          if (ended) return;
          ended = true;
          this.bodies.delete(tracked);
          controller.close();
          if (post) this.completePost(post);
        });
        response.once('error', () => {
          if (ended) return;
          ended = true;
          this.bodies.delete(tracked);
          this.settleBody(controller, tracked);
        });
        response.once('close', () => {
          if (ended) return;
          ended = true;
          this.bodies.delete(tracked);
          this.settleBody(controller, tracked);
        });
      },
      cancel: () => {
        ended = true;
        this.bodies.delete(tracked);
        response.destroy();
        request.destroy();
        if (post) this.completePost(post);
      },
    });
  }

  // The end of a body: the teardown of the session closes the body on
  // purpose, so its error is the teardown's own and never the death of the
  // peer. A body that failed on its own ends with the protocol error.
  private settleBody(
    controller: ReadableStreamDefaultController<Uint8Array>,
    tracked: TrackedBody,
  ) {
    if (tracked.intentional) {
      try {
        controller.close();
      } catch {
        /* The stream is closed either way. */
      }
      return;
    }
    try {
      controller.error(new RuntimeFault('protocol_error'));
    } catch {
      /* The stream is closed either way. */
    }
  }

  // An SSE body is framed before the SDK reads it: every dispatched event is
  // one received message and the ids of a POST response stream are dropped.
  private sseBody(
    post: PostSlot | undefined,
    response: IncomingMessage,
    request: ClientRequest,
    method: string,
    established: boolean,
  ): ReadableStream<Uint8Array> {
    let ended = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const tracked: TrackedBody = { intentional: this.closing };
    this.bodies.add(tracked);
    if (post) post.tracked = tracked;
    const framer = new SseFramer(
      {
        bytes: (count) => {
          if (!this.budgets.countBytes(count))
            throw new RuntimeFault('limit_exceeded');
        },
        text: (value) => {
          if (ended) return;
          try {
            controller.enqueue(this.encoder.encode(value));
          } catch {
            /* The stream is closed either way. */
          }
        },
        event: (data) => {
          if (data === undefined) return;
          if (!this.budgets.countReceived()) {
            ended = true;
            this.breach();
            try {
              controller.error(new RuntimeFault('limit_exceeded'));
            } catch {
              /* The stream is closed either way. */
            }
            response.destroy();
            return;
          }
          if (!post) return;
          let message: { id?: unknown } | undefined;
          try {
            message = JSON.parse(data) as { id?: unknown };
          } catch {
            return;
          }
          const id = message.id;
          if (id === undefined || !post.ids.has(String(id))) return;
          if (!('result' in message) && !('error' in message)) return;
          post.answered.add(String(id));
          // Every id of this body was answered: the body is complete.
          if (post.ids.size > 0 && post.answered.size >= post.ids.size)
            this.completePost(post);
        },
      },
      post !== undefined,
    );
    if (post) post.framer = framer;
    this.framers.add(framer);
    return new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        if (post) post.controller = streamController;
        response.on('data', (chunk: Buffer) => {
          if (ended) return;
          try {
            framer.push(chunk);
          } catch {
            ended = true;
            this.breach();
            streamController.error(new RuntimeFault('limit_exceeded'));
            response.destroy();
          }
        });
        response.once('end', () => {
          if (ended) return;
          ended = true;
          this.bodies.delete(tracked);
          try {
            framer.flush();
          } catch {
            this.breach();
            try {
              streamController.error(new RuntimeFault('limit_exceeded'));
            } catch {
              /* The stream is closed either way. */
            }
          }
          try {
            streamController.close();
          } catch {
            /* The stream is closed either way. */
          }
          this.framers.delete(framer);
          // The end of an established notification stream is the end of the
          // peer: the SDK treats it as a normal end once a response was
          // delivered over it.
          this.notificationEnded(method, established);
          if (post) this.completePost(post);
        });
        response.once('error', () => {
          if (ended || post?.completed) return;
          ended = true;
          this.bodies.delete(tracked);
          this.framers.delete(framer);
          this.settleBody(streamController, tracked);
          this.notificationEnded(method, established);
        });
        response.once('close', () => {
          if (ended || post?.completed) return;
          ended = true;
          this.bodies.delete(tracked);
          this.framers.delete(framer);
          this.settleBody(streamController, tracked);
          this.notificationEnded(method, established);
        });
      },
      cancel: () => {
        ended = true;
        this.bodies.delete(tracked);
        this.framers.delete(framer);
        response.destroy();
        request.destroy();
        if (post) this.completePost(post);
      },
    });
  }

  // The completion of a POST body: the stream given to the SDK ends the way
  // its framing demands, then the upstream reader is cancelled and the
  // response and the request are destroyed. A request that never got its
  // headers is closed with a synthetic answer, so the SDK never blames the
  // peer. The errors of this teardown are suppressed and the slot is released
  // afterwards.
  private completePost(post: PostSlot) {
    if (post.completed) return;
    post.completed = true;
    // An SSE body ends normally; a JSON body ends with the empty answer the
    // SDK parses without an error.
    if (post.complete) post.complete();
    else {
      try {
        post.controller?.close();
      } catch {
        /* The stream is closed either way. */
      }
    }
    // The request that never got its headers ends with an empty answer.
    try {
      post.settle?.({ status: 202, headers: new Headers(), body: null });
    } catch {
      /* The request is gone either way. */
    }
    try {
      post.response?.destroy();
    } catch {
      /* The response is gone either way. */
    }
    try {
      post.request?.destroy();
    } catch {
      /* The request is gone either way. */
    }
    if (post.framer) this.framers.delete(post.framer);
    // The record of the body goes with the body: a finished body keeps no
    // record of its own, and the later error of the socket finds none.
    if (post.tracked) this.bodies.delete(post.tracked);
    this.releaseSlot(post);
  }
}

// The JSON-RPC messages of a POST body; an array counts each element.
function parseMessages(body: string): Array<{ id?: unknown }> {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (item): item is { id?: unknown } =>
        typeof item === 'object' && item !== null,
    );
  } catch {
    return [];
  }
}

// The session mode of the remote transport: the peer keeps one HTTP session
// for the whole life of the pool entry.
export function sessionMcpHttpTransport(
  endpoint: string,
  transport: 'streamable_http' | 'sse',
  signal: AbortSignal,
  died: () => void,
  credentials: Record<string, string> = {},
  fixtureOrigin?: string,
): RemoteSession {
  const session = new RemoteHttpSession(
    endpoint,
    transport,
    signal,
    died,
    credentials,
    fixtureOrigin,
  );
  const result: RemoteSession = {
    transport: session.transport,
    beginOperation: () => session.beginOperation(),
    endOperation: () => session.endOperation(),
    dispose: () => session.dispose(),
    inspect: () => session.inspect(),
  };
  // The read of the state of the session is not enumerable: the session
  // never carries it into a log or a result.
  Object.defineProperty(result, 'inspect', { enumerable: false });
  return result;
}
