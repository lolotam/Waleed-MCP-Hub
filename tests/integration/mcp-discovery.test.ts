import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCapabilityRuntime } from '@waleed/hub-core';
import { enumerateCapabilities } from '../../packages/hub-core/src/runtime/capabilities.js';
import {
  publicAddress,
  safeMcpHttpTransport,
} from '../../packages/hub-core/src/adapters/mcp/http.js';
import { mcpHttpFixture } from '../helpers/mcp-http.js';
import { connector } from '../helpers/runtime.js';

const fixtures: Awaited<ReturnType<typeof mcpHttpFixture>>[] = [];
const directories: string[] = [];
async function http() {
  const fixture = await mcpHttpFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const directory of directories.splice(0))
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
});

describe('real bounded MCP HTTP/SSE discovery', () => {
  it.each(['streamable_http', 'sse'] as const)(
    'initializes and paginates tools/resources/prompts over %s, with zero tools/call',
    async (transport) => {
      const fixture = await http();
      const result = await enumerateCapabilities(
        safeMcpHttpTransport(
          `${fixture.origin}/${transport === 'sse' ? 'sse' : 'mcp'}`,
          transport,
          AbortSignal.timeout(10_000),
          fixture.origin,
        ),
        AbortSignal.timeout(10_000),
      );
      expect(result).toMatchObject({
        protocolVersion: expect.any(String),
        resourceCount: 1,
        promptCount: 1,
      });
      expect(result.tools.map((tool) => tool.name)).toEqual([
        'fixture_first',
        'mcp-add',
        'fixture_second',
      ]);
      expect(result.tools.find((tool) => tool.name === 'mcp-add')?.role).toBe(
        'gateway_management',
      );
      expect(fixture.methods).toContain('notifications/initialized');
      expect(fixture.methods).not.toContain('tools/call');
      expect(
        fixture.headers.every(
          (headers) => !headers.cookie && !headers.authorization,
        ),
      ).toBe(true);
    },
  );
  it.each(['auth', 'version', 'redirect', 'cursor', 'large'])(
    'fails closed for %s without invoking tools or exposing raw peer output',
    async (mode) => {
      const fixture = await http();
      try {
        await enumerateCapabilities(
          safeMcpHttpTransport(
            `${fixture.origin}/${mode}`,
            'streamable_http',
            AbortSignal.timeout(8000),
            fixture.origin,
          ),
          AbortSignal.timeout(8000),
        );
        throw new Error('Unexpected discovery success.');
      } catch (error) {
        expect(error).toHaveProperty('reason');
        expect(String(error)).not.toContain('SYNTHETIC-AUTH');
        if (mode === 'auth')
          expect(error).toHaveProperty('reason', 'auth_required');
      }
      expect(fixture.methods).not.toContain('tools/call');
    },
  );
  it('cancels a stalled connection and refuses local destinations unless an exact fixture policy is constructed', async () => {
    const fixture = await http();
    const controller = new AbortController();
    const result = enumerateCapabilities(
      safeMcpHttpTransport(
        `${fixture.origin}/stall`,
        'streamable_http',
        controller.signal,
        fixture.origin,
      ),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 150);
    await expect(result).rejects.toBeDefined();
    await expect(
      enumerateCapabilities(
        safeMcpHttpTransport(
          `${fixture.origin}/mcp`,
          'streamable_http',
          AbortSignal.timeout(1000),
        ),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toHaveProperty('reason', 'destination_denied');
  });
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '172.16.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '3ffe::1',
    '3fff::1',
    '192.88.99.1',
  ])('denies nonpublic/metadata address %s', (address) => {
    expect(publicAddress(address)).toBe(false);
  });
  it('accepts public addresses without weakening TLS or following redirects', () => {
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe.skipIf(process.platform !== 'win32')(
  'real contained MCP stdio discovery',
  () => {
    it('negotiates and lists capabilities using isolated explicit argv/environment and cleans up its session', async () => {
      const directory = await mkdtemp(
        join('E:\\Dev\\Temp\\opencode', 'hub-mcp space-'),
      );
      directories.push(directory);
      const path = join(directory, 'peer.json');
      const value = connector('native', 'native');
      if (value.executionMode !== 'native') throw new Error();
      value.executable = process.execPath;
      value.arguments = [
        fileURLToPath(new URL('../fixtures/mcp-stdio.mjs', import.meta.url)),
        path,
        'healthy',
        'A B',
        'عربي',
        '"quotes"',
        '$(never); & inert',
      ];
      const runtime = createCapabilityRuntime({ workingDirectory: directory });
      const result = await runtime.discover(value, AbortSignal.timeout(15_000));
      expect(result).toMatchObject({
        resourceCount: 1,
        promptCount: 1,
        tools: [
          { name: 'fixture_first', role: 'upstream' },
          { name: 'fixture_second', role: 'upstream' },
        ],
      });
      const peer = JSON.parse(await readFile(path, 'utf8')) as {
        methods: string[];
        arguments: string[];
        inheritedSecret: null;
      };
      expect(peer.methods).not.toContain('tools/call');
      expect(peer.arguments).toEqual([
        'A B',
        'عربي',
        '"quotes"',
        '$(never); & inert',
      ]);
      expect(peer.inheritedSecret).toBeNull();
    }, 20_000);
    it('cancels only its contained stalled target and does not publish fake capabilities', async () => {
      const directory = await mkdtemp(
        join('E:\\Dev\\Temp\\opencode', 'hub-mcp-cancel-'),
      );
      directories.push(directory);
      const value = connector('native', 'native');
      if (value.executionMode !== 'native') throw new Error();
      value.executable = process.execPath;
      value.arguments = [
        fileURLToPath(new URL('../fixtures/mcp-stdio.mjs', import.meta.url)),
        join(directory, 'peer.json'),
        'stall',
      ];
      const controller = new AbortController();
      const task = createCapabilityRuntime({
        workingDirectory: directory,
      }).discover(value, controller.signal);
      setTimeout(() => controller.abort(), 2000);
      await expect(task).rejects.toBeDefined();
    }, 15_000);
  },
);
