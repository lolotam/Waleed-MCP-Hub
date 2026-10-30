import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createAgentBridge,
  createBindingResolver,
  definitionHash,
  type ProcessRequest,
  type ProcessRunner,
} from '@waleed/hub-core';
import {
  cleanupGatewayContainers,
  createDockerAgentTransport,
} from '../packages/hub-core/src/integrations/docker-transport.js';
import { connector, profileState } from './helpers/runtime.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const sshNames = [
  'ssh-Autoverse-mcp',
  'ssh-Abdelaziz-mcp',
  'ssh-curemed-mcp',
  'ssh-contaboo-mcp',
  'ssh-Musalam-1-mcp',
  'ssh-Musalam-2-mcp',
  'ssh-danatfuture-mcp',
];
const toolNames = [
  'list-connections',
  'read-command',
  'run-command',
  'privileged-command',
  'open-session',
  'list-sessions',
  'read-session-output',
  'close-session',
  'signal-process',
  'sftp-download',
  'sftp-upload',
];
function dockerState(names = ['ssh-synthetic']) {
  const state = profileState([]);
  state.connectors = names.map((name, index) => {
    const value = connector(`ssh-${index}`, 'docker');
    value.name = name;
    const id = `wmh-secret-${randomUUID()}`;
    value.secretBindings = { SSH_MCP_PASSWORD: id };
    state.secretReferences.push({
      id,
      adapter: 'docker',
      present: true,
      kind: 'credential',
      ownerIds: [value.id],
    });
    value.trustApproval!.definitionHash = definitionHash(value);
    return value;
  });
  return state;
}
async function fixture(state = dockerState()) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-docker-bridge-'));
  directories.push(directory);
  const requests: ProcessRequest[] = [];
  const commands: string[][] = [];
  const methods: string[] = [];
  const calls: Array<{ name: string; arguments?: unknown }> = [];
  const artifacts: string[] = [];
  const runner: ProcessRunner = {
    async run(request) {
      requests.push(request);
      if (!request.stream)
        throw new Error('No credential value may be read or written.');
      let prefix = '';
      if (request.arguments[0] === 'mcp') {
        for (const flag of [
          '--catalog',
          '--config',
          '--tools-config',
          '--registry',
        ]) {
          const path = request.arguments[request.arguments.indexOf(flag) + 1]!;
          artifacts.push(await readFile(path, 'utf8'));
        }
        const catalogPath =
          request.arguments[request.arguments.indexOf('--catalog') + 1]!;
        const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
          registry: Record<string, { prefix: string }>;
        };
        prefix = Object.values(catalog.registry)[0]!.prefix + '__';
      }
      const stream = request.stream;
      stream.started((data) => {
        const message = JSON.parse(data) as {
          id?: number;
          method: string;
          params?: { name: string; arguments?: unknown };
        };
        methods.push(message.method);
        if (message.id === undefined) return;
        if (message.method === 'tools/call') {
          if (!toolNames.some((name) => prefix + name === message.params?.name))
            throw new Error('Gateway route was not stable across reconnects.');
          calls.push(message.params!);
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'synthetic-gateway', version: '1' },
              }
            : message.method === 'tools/list'
              ? {
                  tools: toolNames.map((name) => ({
                    name: prefix + name,
                    inputSchema: { type: 'object' },
                  })),
                }
              : { content: [{ type: 'text', text: 'synthetic hostname' }] };
        stream.stdout(
          Buffer.from(
            JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n',
          ),
        );
      });
      if (!request.signal.aborted)
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      return { outcome: 'cancelled', exitCode: null, stdout: '', stderr: '' };
    },
  };
  const docker = {
    executable: 'C:\\Synthetic\\docker.exe',
    environment: { PATH: 'C:\\Synthetic' },
    async run(args: readonly string[]) {
      commands.push([...args]);
      if (args[0] === 'version') return '29.9.2';
      if (args.slice(0, 3).join(' ') === 'mcp secret ls')
        return JSON.stringify(
          state.secretReferences
            .filter((r) => r.present)
            .map(({ id }) => ({ name: id })),
        );
      if (args[0] === 'ps') return '';
      throw new Error('Unexpected Docker operation.');
    },
  };
  const launch = (
    value = state.connectors[0]!,
    signal = AbortSignal.timeout(5000),
  ) => {
    if (value.executionMode !== 'docker') throw new Error();
    return createDockerAgentTransport({
      connector: value,
      directory,
      catalogDirectory: join(directory, 'catalogs'),
      docker,
      runner,
      signal,
      resolveBindings: (backend) =>
        createBindingResolver({ docker: backend }, async () => state)(
          value,
          signal,
        ),
    });
  };
  return {
    state,
    directory,
    requests,
    commands,
    methods,
    calls,
    artifacts,
    docker,
    runner,
    launch,
  };
}

describe('Docker-secret-backed agent bridge', () => {
  it('exposes all 77 SSH tools via reference-only gateways and forwards only explicit calls', async () => {
    const f = await fixture(dockerState(sshNames));
    const bridge = createAgentBridge(
      async () => structuredClone(f.state),
      async (value, signal) => {
        const docker = await f.launch(value, signal);
        const client = new Client(
          { name: 'synthetic-peer', version: '1' },
          { capabilities: {} },
        );
        try {
          await client.connect(docker.transport);
        } catch (error) {
          await docker.dispose();
          throw error;
        }
        return {
          client,
          assertPublic() {},
          async dispose() {
            await client.close();
            await docker.dispose();
          },
        };
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    const agent = new Client(
      { name: 'synthetic-agent', version: '1' },
      { capabilities: {} },
    );
    await agent.connect(b);
    try {
      const list = await agent.listTools();
      expect(list.tools).toHaveLength(77);
      for (const name of sshNames)
        expect(
          list.tools.filter((t) => t.description?.startsWith(`${name}:`)),
        ).toHaveLength(11);
      expect(f.methods).not.toContain('tools/call');
      expect(new Set(list.tools.map((t) => t.name)).size).toBe(77);
      const target = list.tools.find(
        (t) => t.name === 'ssh-autoverse-mcp__wmh_read-command',
      )!;
      expect(
        await agent.callTool({
          name: target.name,
          arguments: { command: 'uname -n' },
        }),
      ).toMatchObject({ content: [{ text: 'synthetic hostname' }] });
      expect(f.methods.filter((m) => m === 'tools/call')).toHaveLength(1);
      expect(f.calls).toEqual([
        { name: 'wmh__read-command', arguments: { command: 'uname -n' } },
      ]);
      for (const request of f.requests) {
        expect(request.arguments.slice(0, 3)).toEqual([
          'mcp',
          'gateway',
          'run',
        ]);
        expect(request.arguments).toEqual(
          expect.arrayContaining([
            '--servers',
            '--log-calls=false',
            '--block-secrets=true',
            '--watch=false',
            '--secrets=docker-desktop',
          ]),
        );
        expect(request.arguments).not.toContain('--profile');
        expect(request.environment).not.toHaveProperty('SSH_MCP_PASSWORD');
        expect(request.stdin).toBeUndefined();
      }
      const catalog = JSON.parse(f.artifacts[0]!) as {
        registry: Record<string, { secrets: unknown }>;
      };
      expect(Object.values(catalog.registry)[0]!.secrets).toEqual([
        { name: f.state.secretReferences[0]!.id, env: 'SSH_MCP_PASSWORD' },
      ]);
      expect(f.requests).toHaveLength(7);
      expect(await readdir(join(f.directory, 'catalogs'))).toHaveLength(7);
      expect(
        await readdir(join(f.directory, 'owned-agent-containers')),
      ).toHaveLength(14);
      f.state.connectors.find((c) => c.name === 'ssh-Autoverse-mcp')!.enabled =
        false;
      const starts = f.requests.length;
      expect(await agent.callTool({ name: target.name })).toMatchObject({
        isError: true,
      });
      expect(f.requests).toHaveLength(starts);
      const changed = f.state.connectors.find(
        (c) => c.name === 'ssh-Autoverse-mcp',
      )!;
      changed.enabled = true;
      if (changed.executionMode !== 'docker') throw new Error();
      changed.arguments.push('--unapproved-change');
      expect(await agent.callTool({ name: target.name })).toMatchObject({
        isError: true,
      });
      expect(f.requests).toHaveLength(starts);
    } finally {
      await agent.close();
      await bridge.close();
    }
    expect(await readdir(join(f.directory, 'catalogs'))).toEqual([]);
    expect(await readdir(join(f.directory, 'owned-agent-containers'))).toEqual(
      [],
    );
  });

  it.each([
    'missing',
    'foreign',
    'windows',
    'oauth',
    'unsafe-id',
    'unsafe-env',
    'literal-override',
    'header',
  ])('fails closed for %s bindings without reading values', async (reason) => {
    const state = dockerState();
    const value = state.connectors[0]!;
    const reference = state.secretReferences[0]!;
    if (reason === 'missing') reference.present = false;
    if (reason === 'foreign') reference.ownerIds = ['other'];
    if (reason === 'windows') reference.adapter = 'windows';
    if (reason === 'oauth') reference.kind = 'oauth';
    if (reason === 'unsafe-id') {
      reference.id = 'foreign-secret';
      value.secretBindings.SSH_MCP_PASSWORD = reference.id;
    }
    if (reason === 'unsafe-env')
      value.secretBindings = { NODE_OPTIONS: reference.id };
    if (reason === 'literal-override')
      value.environmentLiterals = { SSH_MCP_PASSWORD: 'synthetic-override' };
    if (reason === 'header')
      value.headerBindings = { Authorization: reference.id };
    const read = vi.fn(async () => Buffer.from('SYNTHETIC_PRIVATE_VALUE'));
    const backend = {
      has: vi.fn(async () => true),
      read,
      put: vi.fn(),
      delete: vi.fn(),
    };
    await expect(
      createBindingResolver(
        { docker: backend, windows: backend },
        async () => state,
      )(value, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ reason: 'secrets_pending' });
    expect(read).not.toHaveBeenCalled();
  });

  it('checks actual Docker metadata, never reads plaintext, and clears reference leases', async () => {
    const state = dockerState();
    const value = state.connectors[0]!;
    const backend = {
      has: vi.fn(async () => true),
      read: vi.fn(async () => {
        throw new Error('Never read Docker secrets.');
      }),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const resolve = createBindingResolver(
      { docker: backend },
      async () => state,
    );
    const lease = await resolve(value, AbortSignal.timeout(1000));
    expect(lease.environment).toEqual({});
    expect(lease.headers).toEqual({});
    expect(lease.dockerSecrets).toHaveLength(1);
    expect(backend.read).not.toHaveBeenCalled();
    lease.dispose();
    expect(lease.dockerSecrets).toEqual([]);
    backend.has.mockResolvedValue(false);
    await expect(
      resolve(value, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ reason: 'secrets_pending' });
    const f = await fixture(state);
    f.docker.run = async () => '[]';
    await expect(f.launch()).rejects.toMatchObject({
      reason: 'secrets_pending',
    });
    expect(f.requests).toEqual([]);
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('cleans up cancellation idempotently and refuses to erase catalog drift', async () => {
    const f = await fixture();
    const docker = await f.launch();
    await docker.transport.start();
    await Promise.all([docker.dispose(), docker.dispose()]);
    expect(f.commands.filter((args) => args[0] === 'ps')).toHaveLength(2);
    expect(await readdir(join(f.directory, 'owned-agent-containers'))).toEqual(
      [],
    );
    const next = await f.launch();
    const catalogPath = join(
      f.directory,
      'catalogs',
      (await readdir(join(f.directory, 'catalogs')))[0]!,
    );
    await writeFile(catalogPath, 'SYNTHETIC_EXTERNAL_EDIT');
    await expect(next.dispose()).rejects.toBeDefined();
    expect(await readFile(catalogPath, 'utf8')).toBe('SYNTHETIC_EXTERNAL_EDIT');
    await expect(f.launch()).rejects.toThrow(
      'Owned container recovery is pending.',
    );
  });

  it('retains recovery evidence after uncertain container cleanup', async () => {
    const f = await fixture();
    const docker = await f.launch();
    const run = f.docker.run;
    f.docker.run = async (args) => {
      if (args[0] === 'ps') return 'a'.repeat(64);
      if (args[0] === 'inspect')
        return JSON.stringify({ 'docker-mcp-name': 'foreign' });
      return run(args);
    };
    await expect(docker.dispose()).rejects.toMatchObject({ uncertain: true });
    expect(
      (await readdir(join(f.directory, 'owned-agent-containers'))).length,
    ).toBeGreaterThan(0);
    expect(await readdir(join(f.directory, 'catalogs'))).toHaveLength(1);
    expect(f.commands.some((args) => args[0] === 'rm')).toBe(false);
  });

  it('sanitizes startup failures and cleans the owned gateway artifacts', async () => {
    const f = await fixture();
    const docker = await f.launch();
    f.runner.run = async () => {
      throw new Error('SYNTHETIC_PRIVATE_STARTUP_DIAGNOSTIC');
    };
    await expect(docker.transport.start()).rejects.toMatchObject({
      reason: 'dependency_unavailable',
    });
    await docker.dispose();
    expect(await readdir(join(f.directory, 'owned-agent-containers'))).toEqual(
      [],
    );
    expect(await readdir(join(f.directory, 'catalogs'))).toEqual([]);
  });

  it('cleans up failed artifact preparation and permits a clean retry', async () => {
    const f = await fixture();
    const blocked = join(f.directory, 'catalogs');
    await writeFile(blocked, 'SYNTHETIC_NOT_A_DIRECTORY');
    await expect(f.launch()).rejects.toBeDefined();
    expect(await readdir(join(f.directory, 'owned-agent-containers'))).toEqual(
      [],
    );
    await rm(blocked);
    const retry = await f.launch();
    await retry.dispose();
  });

  it('does not mistake unsafe recovery metadata for an active persistent peer', async () => {
    const f = await fixture();
    const blocked = join(f.directory, 'catalogs');
    const foreign = join(f.directory, 'foreign');
    await mkdir(foreign);
    await symlink(foreign, blocked, 'junction');
    await expect(f.launch()).rejects.toBeDefined();
    await unlink(blocked);
    // Failed compensation must stay recovery-blocking even if metadata reads fail.
    await expect(f.launch()).rejects.toThrow(
      'Owned container recovery is pending.',
    );
  });

  it('keeps secretless Docker execution direct and rejects unsupported gateway reinterpretation', async () => {
    const state = dockerState();
    const value = state.connectors[0]!;
    if (value.executionMode !== 'docker') throw new Error();
    value.arguments = ['{{unsafe}}'];
    const f = await fixture(state);
    await expect(f.launch()).rejects.toMatchObject({
      reason: 'adapter_pending',
    });
    expect(f.commands).toEqual([]);
    value.arguments = [];
    value.portBindings = [{ host: 1234, container: 1234 }];
    await expect(f.launch()).rejects.toMatchObject({
      reason: 'adapter_pending',
    });
    value.portBindings = [];
    value.secretBindings = {};
    const docker = await f.launch();
    await docker.transport.start();
    expect(f.requests[0]!.arguments[0]).toBe('run');
    expect(f.requests[0]!.arguments).toContain(value.image);
    await docker.dispose();
    expect(await readdir(join(f.directory, 'owned-agent-containers'))).toEqual(
      [],
    );
  });
});

it('removes only exact nonce-labelled gateway containers and verifies absence', async () => {
  const server = `wmh-${randomUUID()}`;
  let removed = false;
  const calls: string[][] = [];
  const docker = {
    executable: '',
    environment: {},
    async run(args: readonly string[]) {
      calls.push([...args]);
      if (args[0] === 'ps') return removed ? '' : 'b'.repeat(64);
      if (args[0] === 'inspect')
        return JSON.stringify({
          'docker-mcp-name': server,
          'docker-mcp': 'true',
          'docker-mcp-tool-type': 'mcp',
          'docker-mcp-transport': 'stdio',
        });
      if (args[0] === 'rm') removed = true;
      return '';
    },
  };
  await cleanupGatewayContainers(docker, server);
  expect(calls.find((args) => args[0] === 'rm')).toEqual([
    'rm',
    '--force',
    'b'.repeat(64),
  ]);
  expect(
    calls
      .filter((args) => args[0] === 'ps')
      .every((args) => args.includes(`label=docker-mcp-name=${server}`)),
  ).toBe(true);
  await expect(
    cleanupGatewayContainers(docker, 'waleed-mcp-hub-pilot'),
  ).rejects.toMatchObject({ uncertain: true });
});
