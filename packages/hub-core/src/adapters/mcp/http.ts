import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type {
  Transport,
  FetchLike,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { RuntimeFault } from '../../runtime/capabilities.js';
import { isLocalHttpEndpoint } from '@waleed/contracts';

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
// A local fixture origin is a construction-time testing exception, never browser
// input or a global allow-private switch. Production only creates the default.
export function restrictedFetch(
  endpoint: string,
  signal: AbortSignal,
  fixtureOrigin?: string,
  credentials:
    Record<string, string> | (() => Promise<Record<string, string>>) = {},
  exposeChallenge = false,
  localHttpOptIn = false,
): FetchLike {
  const origin = new URL(endpoint).origin;
  const local = localHttpOptIn && isLocalHttpEndpoint(endpoint);
  let bytes = 0,
    requests = 0;
  const secureFetch: FetchLike = async (input, init = {}) => {
    signal.throwIfAborted();
    const url = new URL(String(input));
    if (++requests > 64) throw new RuntimeFault('limit_exceeded');
    const fixture =
      fixtureOrigin === origin &&
      origin === url.origin &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      (!fixture &&
        !(local && url.protocol === 'http:') &&
        url.protocol !== 'https:')
    )
      throw new RuntimeFault('destination_denied');
    const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const addresses = fixture
      ? [{ address: '127.0.0.1', family: 4 }]
      : isIP(url.hostname.replace(/^\[|\]$/g, ''))
        ? [
            {
              address: url.hostname.replace(/^\[|\]$/g, ''),
              family: isIP(url.hostname.replace(/^\[|\]$/g, '')),
            },
          ]
        : await new Promise<Array<{ address: string; family: number }>>(
            (resolve, reject) => {
              const abort = () =>
                reject(new RuntimeFault('destination_denied'));
              if (dnsSignal.aborted) {
                abort();
                return;
              }
              dnsSignal.addEventListener('abort', abort, { once: true });
              lookup(url.hostname, { all: true, verbatim: true })
                .then(resolve, () =>
                  reject(new RuntimeFault('destination_denied')),
                )
                .finally(() => dnsSignal.removeEventListener('abort', abort));
            },
          );
    if (
      !addresses.length ||
      (!fixture &&
        addresses.some((item) =>
          local
            ? !['127.0.0.1', '::1'].includes(item.address)
            : !publicAddress(item.address),
        ))
    )
      throw new RuntimeFault('destination_denied');
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
    const credentialHeaders =
      typeof credentials === 'function' ? await credentials() : credentials;
    for (const [key, value] of Object.entries(credentialHeaders)) {
      if (
        !/^(?:Authorization|X-[a-z0-9-]+|Api-Key)$/i.test(key) ||
        /[\r\n\0]/.test(value) ||
        value.length > 8192
      )
        throw new RuntimeFault('secrets_pending');
      headers[key.toLowerCase()] = value;
    }
    if (
      init.body !== undefined &&
      init.body !== null &&
      (typeof init.body !== 'string' ||
        Buffer.byteLength(init.body, 'utf8') > 32 * 1024)
    )
      throw new RuntimeFault('limit_exceeded');
    const requestSignal = init.signal
      ? AbortSignal.any([signal, init.signal])
      : signal;
    return new Promise<Response>((resolve, reject) => {
      const request = (fixture || local ? httpRequest : httpsRequest)(
        url,
        {
          method: init.method ?? 'GET',
          headers,
          signal: requestSignal,
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
          // Bound header establishment, not quiet periods in an established MCP
          // event stream. Its AbortSignal and bridge idle/lifetime limits remain
          // authoritative; JSON bodies retain the short inactivity timeout.
          if (
            /text\/event-stream/i.test(headers.accept ?? '') &&
            /text\/event-stream/i.test(
              String(response.headers['content-type'] ?? ''),
            )
          )
            request.setTimeout(0);
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new RuntimeFault('destination_denied'));
            return;
          }
          if (!exposeChallenge && (status === 401 || status === 403)) {
            response.destroy();
            reject(new RuntimeFault('auth_required'));
            return;
          }
          const resultHeaders = new Headers();
          for (const key of [
            'content-type',
            'mcp-session-id',
            'mcp-protocol-version',
            ...(exposeChallenge ? ['www-authenticate'] : []),
          ]) {
            const value = response.headers[key];
            if (typeof value === 'string' && value.length <= 2048)
              resultHeaders.set(key, value);
          }
          let ended = false;
          const body = new ReadableStream<Uint8Array>({
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
          resolve(
            new Response([204, 205, 304].includes(status) ? null : body, {
              status,
              headers: resultHeaders,
            }),
          );
        },
      );
      request.once('timeout', () =>
        request.destroy(new RuntimeFault('timed_out')),
      );
      request.once('error', (error) =>
        reject(
          error instanceof RuntimeFault
            ? error
            : new RuntimeFault(
                requestSignal.aborted ? 'cancelled' : 'dependency_unavailable',
              ),
        ),
      );
      request.end(typeof init.body === 'string' ? init.body : undefined);
    });
  };
  return secureFetch;
}
export function safeMcpHttpTransport(
  endpoint: string,
  transport: 'streamable_http' | 'sse',
  signal: AbortSignal,
  fixtureOrigin?: string,
  credentials:
    Record<string, string> | (() => Promise<Record<string, string>>) = {},
  localHttpOptIn = false,
): Transport & { terminateSession?: () => Promise<void> } {
  const secureFetch = restrictedFetch(
    endpoint,
    signal,
    fixtureOrigin,
    credentials,
    false,
    localHttpOptIn,
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
