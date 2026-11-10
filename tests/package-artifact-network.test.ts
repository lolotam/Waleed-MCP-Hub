import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request, type RequestOptions } from 'node:https';
import type {
  ClientRequest as HttpRequest,
  IncomingMessage as HttpMessage,
} from 'node:http';
import {
  downloadArtifact,
  MAX_ARTIFACT_BYTES,
} from '../packages/hub-core/src/packages/artifact.js';

vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: vi.fn(),
}));
const source = {
  kind: 'github-release' as const,
  repository: 'owner/repo',
  tag: 'v1',
  assetName: 'root.tgz',
  sha256: 'a'.repeat(64),
};

type Reply = {
  status: number;
  location?: string;
  body?: Buffer;
  length?: number;
  encoding?: string;
  stall?: boolean;
  incomplete?: boolean;
};
const calls: Array<{ url: string; options: RequestOptions }> = [];
function serve(replies: Reply[]) {
  vi.mocked(request).mockImplementation(((
    url: URL,
    options: RequestOptions,
    callback: (response: HttpMessage) => void,
  ) => {
    calls.push({ url: url.href, options });
    const reply = replies.shift();
    const outgoing = new EventEmitter() as HttpRequest;
    outgoing.destroy = () => outgoing;
    outgoing.end = (() => {
      queueMicrotask(() => {
        if (!reply) {
          outgoing.emit('error', new Error('Unexpected request'));
          return;
        }
        const stream = new PassThrough();
        const response = stream as unknown as HttpMessage;
        Object.assign(response, {
          statusCode: reply.status,
          complete: !reply.incomplete,
          headers: {
            ...(reply.location ? { location: reply.location } : {}),
            ...(reply.length ? { 'content-length': String(reply.length) } : {}),
            ...(reply.encoding ? { 'content-encoding': reply.encoding } : {}),
          },
        });
        response.on('error', () => undefined);
        callback(response);
        if (!reply.stall) stream.end(reply.body ?? Buffer.from('artifact'));
      });
      return outgoing;
    }) as HttpRequest['end'];
    options.signal?.addEventListener(
      'abort',
      () => outgoing.emit('error', new Error('aborted')),
      { once: true },
    );
    return outgoing;
  }) as typeof request);
}
afterEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
  vi.mocked(request).mockReset();
});

describe('bounded GitHub downloads', () => {
  it('follows only the allowlisted asset redirect without forwarding ambient credentials', async () => {
    serve([
      {
        status: 302,
        location:
          'https://release-assets.githubusercontent.com/asset?signature=private',
      },
      { status: 200 },
    ]);
    expect(
      (await downloadArtifact(source, new AbortController().signal)).toString(),
    ).toBe('artifact');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options.headers).not.toHaveProperty('authorization');
      expect(call.options.headers).not.toHaveProperty('cookie');
      expect(call.options.rejectUnauthorized).toBe(true);
    }
  });
  it.each([
    'http://github.com/x',
    'https://evil.test/x',
    'https://github.com.evil.test/x',
    'https://user@github.com/x',
    'https://127.0.0.1/x',
    'https://github.com/x#fragment',
  ])('never connects to refused destination %s', async (location) => {
    serve([{ status: 302, location }]);
    await expect(
      downloadArtifact(source, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'foreign_host' });
    expect(calls).toHaveLength(1);
  });
  it('caps redirect chains', async () => {
    serve(
      Array.from({ length: 4 }, () => ({
        status: 302,
        location: 'https://github.com/x',
      })),
    );
    await expect(
      downloadArtifact(source, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'foreign_host' });
    expect(calls).toHaveLength(4);
  });
  it.each([
    { length: MAX_ARTIFACT_BYTES + 1 },
    { body: Buffer.alloc(MAX_ARTIFACT_BYTES + 1) },
  ])('caps declared or chunked size', async (extra) => {
    serve([{ status: 200, ...extra }]);
    await expect(
      downloadArtifact(source, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'install_limit' });
  });
  it.each([{ encoding: 'gzip' }, { incomplete: true }, { status: 403 }])(
    'refuses encoding, partial response and non-success',
    async (extra) => {
      serve([{ status: 200, ...extra }]);
      await expect(
        downloadArtifact(source, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'registry_unavailable' });
    },
  );
  it('aborts a stalled active transfer when the caller cancels', async () => {
    serve([{ status: 200, stall: true }]);
    const controller = new AbortController();
    const pending = downloadArtifact(source, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toHaveLength(1);
  });
  it('ends a stalled transfer on the total deadline with a sanitized error', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    serve([{ status: 200, stall: true }]);
    const pending = downloadArtifact(source, new AbortController().signal);
    await Promise.resolve();
    deadline.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'registry_unavailable',
    });
    expect(calls).toHaveLength(1);
  });
  it('does not create a request after cancellation', async () => {
    serve([]);
    await expect(
      downloadArtifact(source, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toHaveLength(0);
  });
});
