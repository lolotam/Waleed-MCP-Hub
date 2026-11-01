import { expect, it, vi } from 'vitest';
import { createUpdateChecker } from '../packages/hub-core/src/updates.js';
import { releaseVersion } from '../scripts/release-version.mjs';
import { createHubServer } from '../apps/server/src/app.js';
import { createLifecycle } from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';
const root = 'https://github.com/lolotam/Waleed-MCP-Hub';
const release = (tag = 'v0.1.2') => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `${root}/releases/tag/${tag}`,
  assets: [
    {
      name: 'Waleed-MCP-Hub-Setup.exe',
      browser_download_url: `${root}/releases/download/${tag}/Waleed-MCP-Hub-Setup.exe`,
    },
  ],
});
it('notifies only about newer stable releases and exposes validated repository links', async () => {
  for (const [current, tag, state] of [
    ['0.1.1', 'v0.1.2', 'available'],
    ['0.1.2', 'v0.1.2', 'current'],
    ['0.2.0', 'v0.1.9', 'current'],
    ['0.1.9', 'v0.1.10', 'available'],
  ]) {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(release(tag)),
    );
    const checker = createUpdateChecker(current!, request);
    expect(await checker.check()).toMatchObject({
      state,
      reason: 'none',
      latestVersion: tag!.slice(1),
    });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe(
      'https://api.github.com/repos/lolotam/Waleed-MCP-Hub/releases/latest',
    );
    expect(options?.redirect).toBe('error');
    expect(options?.headers).not.toHaveProperty('Authorization');
    await checker.close();
  }
});
it('coalesces concurrent checks and caches successful responses for an hour', async () => {
  let now = 1_800_000_000_000;
  const request = vi.fn<typeof fetch>(async () => Response.json(release()));
  const checker = createUpdateChecker('0.1.0', request, () => now);
  await Promise.all([checker.check(), checker.check(), checker.check()]);
  expect(request).toHaveBeenCalledTimes(1);
  now += 3_599_999;
  await checker.check();
  expect(request).toHaveBeenCalledTimes(1);
  now++;
  await checker.check();
  expect(request).toHaveBeenCalledTimes(2);
  await checker.close();
});
it('keeps network, missing release and rate failures separate from local application health', async () => {
  for (const [response, reason] of [
    [new Response('', { status: 404 }), 'no_release'],
    [new Response('', { status: 429 }), 'rate_limit'],
    [new Response('', { status: 503 }), 'network'],
  ] as const) {
    const checker = createUpdateChecker('0.1.0', async () => response);
    expect(await checker.check()).toMatchObject({
      state: 'unavailable',
      reason,
      downloadUrl: null,
    });
    await checker.close();
  }
  const checker = createUpdateChecker('0.1.0', async () => {
    throw new Error('offline');
  });
  expect((await checker.check()).reason).toBe('network');
  await checker.close();
});
it('rejects oversized metadata, prereleases and foreign or missing download links', async () => {
  for (const response of [
    new Response('x'.repeat(128 * 1024 + 1)),
    Response.json({ ...release(), prerelease: true }),
    Response.json({
      ...release(),
      assets: [
        {
          name: 'Waleed-MCP-Hub-Setup.exe',
          browser_download_url: 'https://evil.test/setup.exe',
        },
      ],
    }),
    Response.json({ ...release(), html_url: 'https://evil.test/notes' }),
    Response.json({ ...release(), assets: [] }),
  ]) {
    const checker = createUpdateChecker('0.1.0', async () => response);
    expect(await checker.check()).toMatchObject({
      state: 'unavailable',
      reason: 'invalid_response',
      downloadUrl: null,
    });
    await checker.close();
  }
});
it('selects increasing stable patch versions and never republishes a completed commit', () => {
  const sha = 'a'.repeat(40),
    other = 'b'.repeat(40);
  expect(releaseVersion('0.1.0', [], sha)).toEqual({
    version: '0.1.1',
    tag: 'v0.1.1',
    skip: false,
  });
  const previous = {
    tag_name: 'v0.1.9',
    target_commitish: other,
    draft: false,
    prerelease: false,
  };
  expect(releaseVersion('0.1.0', [previous], sha).tag).toBe('v0.1.10');
  expect(releaseVersion('0.1.0', [{ ...previous, draft: true }], sha).tag).toBe(
    'v0.1.10',
  );
  expect(releaseVersion('1.0.0', [previous], sha).tag).toBe('v1.0.1');
  expect(
    releaseVersion('0.1.0', [{ ...previous, target_commitish: sha }], sha).skip,
  ).toBe(true);
  expect(
    releaseVersion(
      '0.1.0',
      [
        {
          ...previous,
          target_commitish: sha,
          draft: true,
          body: `<!-- wmh-release:${sha} -->`,
        },
      ],
      sha,
    ),
  ).toEqual({ version: '0.1.9', tag: 'v0.1.9', skip: false });
  expect(
    releaseVersion(
      '0.1.0',
      [{ ...previous, target_commitish: sha, draft: true }],
      sha,
    ).tag,
  ).toBe('v0.1.10');
  expect(() => releaseVersion('0.1.0', [], 'main')).toThrow();
});

it('protects update checks, keeps status reads local, and rejects caller-controlled repository URLs', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json(release()));
  const server = await createHubServer({
    port: 4177,
    lifecycle: createLifecycle(memoryStore()),
    updates: createUpdateChecker('0.1.0', request),
  });
  const host = '127.0.0.1:4177',
    origin = `http://${host}`;
  try {
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/updates/check',
          headers: { host, origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const session = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token: server.issueLaunchToken() },
    });
    const headers = {
      host,
      origin,
      cookie: String(session.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': session.json().csrfToken,
    };
    expect(
      (await server.app.inject({ url: '/api/updates', headers })).json().state,
    ).toBe('not_checked');
    expect(request).not.toHaveBeenCalled();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/updates/check',
          headers,
          payload: { url: 'https://evil.test/' },
        })
      ).statusCode,
    ).toBe(400);
    expect(request).not.toHaveBeenCalled();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/updates/check',
          headers: { host, origin, cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/updates/check',
          headers,
          payload: {},
        })
      ).json().state,
    ).toBe('available');
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await server.app.close();
  }
});
