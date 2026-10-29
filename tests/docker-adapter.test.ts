import { describe, expect, it } from 'vitest';
import {
  dockerCommand,
  dockerProfiles,
  type ProcessRunner,
} from '@waleed/hub-core';
import { cleanupOwnedContainers } from '../packages/hub-core/src/adapters/mcp/container-cleanup.js';
import { isolatedNativeArguments } from '../packages/hub-core/src/adapters/mcp/runtime.js';
import { connector } from './helpers/runtime.js';
import { managedFixture } from './helpers/materialization.js';

describe('Docker command safety and owned cleanup', () => {
  it('refuses remote contexts before invoking gateway/profile mutations and forwards no provider secrets', async () => {
    const calls: Array<{
      arguments: readonly string[];
      environment: Readonly<Record<string, string>>;
    }> = [];
    const runner: ProcessRunner = {
      async run(request) {
        calls.push(request);
        return {
          outcome: 'exited',
          exitCode: 0,
          stdout: JSON.stringify('tcp://remote.test:2375'),
          stderr: '',
        };
      },
    };
    const command = dockerCommand(runner, 'C:\\Synthetic\\docker.exe', {
      USERPROFILE: 'C:\\Synthetic',
      PRIVATE_TOKEN: 'SYNTHETIC-NOT-FORWARDED',
      PATH: 'C:\\Untrusted user scripts',
    });
    await expect(
      command.run(
        ['mcp', 'profile', 'import', 'fixed.json'],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments[0]).toBe('context');
    expect(calls[0]?.environment).not.toHaveProperty('PRIVATE_TOKEN');
    expect(calls[0]?.environment.PATH).toContain('C:\\Synthetic');
    expect(calls[0]?.environment.PATH).not.toContain('Untrusted');
  });
  it('permits only the version-verified local adapter and refuses foreign/pilot IDs', async () => {
    const fixture = managedFixture();
    const calls: string[][] = [];
    const command = {
      executable: 'C:\\Synthetic\\docker.exe',
      environment: {},
      async run(args: readonly string[]) {
        calls.push([...args]);
        return '[]';
      },
    };
    const profiles = dockerProfiles(command, fixture.files);
    await expect(
      profiles.read('waleed-mcp-hub-pilot', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      profiles.remove('../outside', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toEqual([]);
  });
  it('removes only inspected containers with the exact immutable nonce and connector ownership labels', async () => {
    const nonce = '12345678-1234-1234-1234-123456789abc',
      id = 'a'.repeat(64);
    const calls: string[][] = [];
    let listed = false;
    const command = {
      executable: '',
      environment: {},
      async run(args: readonly string[]) {
        calls.push([...args]);
        if (args[0] === 'ps') {
          if (listed) return '';
          listed = true;
          return id;
        }
        if (args[0] === 'inspect')
          return JSON.stringify({
            'wmh.client': nonce,
            'wmh.connector': 'fixture',
          });
        return '';
      },
    };
    await cleanupOwnedContainers(command, nonce, 'fixture');
    expect(calls.find((call) => call[0] === 'rm')).toEqual([
      'rm',
      '--force',
      id,
    ]);
    expect(
      calls
        .filter((call) => call[0] === 'ps')
        .every((call) => call.includes(`label=wmh.client=${nonce}`)),
    ).toBe(true);
  });
  it('never deletes a foreign container and reports uncertain cleanup as recovery-required', async () => {
    const nonce = '12345678-1234-1234-1234-123456789abc';
    const calls: string[][] = [];
    const command = {
      executable: '',
      environment: {},
      async run(args: readonly string[]) {
        calls.push([...args]);
        if (args[0] === 'ps') return 'b'.repeat(64);
        return JSON.stringify({
          'wmh.client': 'foreign',
          'wmh.connector': 'fixture',
        });
      },
    };
    await expect(
      cleanupOwnedContainers(command, nonce, 'fixture'),
    ).rejects.toMatchObject({ uncertain: true });
    expect(calls.some((call) => call[0] === 'rm')).toBe(false);
  });
  it('forces known Chrome MCP into isolated sessions and refuses personal attachment flags', () => {
    const value = connector('chrome', 'native');
    if (value.executionMode !== 'native') throw new Error();
    value.arguments = ['chrome-devtools-mcp.js'];
    expect(isolatedNativeArguments(value)).toEqual([
      'chrome-devtools-mcp.js',
      '--isolated',
    ]);
    value.arguments.push('--browserURL=http://127.0.0.1:9222');
    expect(() => isolatedNativeArguments(value)).toThrow();
  });
});
