import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConnectorSchema,
  PackageSpecSchema,
  type Connector,
} from '@waleed/contracts';
import {
  createLifecycle,
  definitionHash,
  createMemorySafetyLedger,
  createAgentBridge,
  createWindowsProcessRunner,
  emptyState,
} from '@waleed/hub-core';
import {
  createPackageRuntime,
  packageArguments,
  type PackageTools,
} from '../packages/hub-core/src/adapters/packages.js';
import {
  normalizeImport,
  clearImport,
} from '../packages/hub-core/src/imports/normalize.js';
import { addManualMcp } from '../packages/hub-core/src/integrations/manual.js';
import type { ProcessRequest } from '../packages/hub-core/src/ports.js';
import { ContainedStdioTransport } from '../packages/hub-core/src/adapters/mcp/stdio.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
});
function packaged(
  manager: 'npm' | 'uvx' = 'npm',
): Extract<Connector, { executionMode: 'package' }> {
  const value = ConnectorSchema.parse({
    id: 'package-fixture',
    name: 'Pinned synthetic package',
    description: '',
    enabled: true,
    revision: 1,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    executionMode: 'package',
    transport: 'stdio',
    package: {
      manager,
      name: manager === 'npm' ? '@synthetic/mcp' : 'synthetic-mcp',
      version: '1.2.3',
      entryPoint: 'synthetic-mcp',
    },
    arguments: ['--Case', '$(inert)', 'أهلا'],
    environmentLiterals: {},
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
  });
  if (value.executionMode !== 'package') throw new Error();
  value.trustApproval = {
    revision: 1,
    approvedAt: value.createdAt,
    risk: 'native_execution',
    definitionHash: definitionHash(value),
  };
  return value;
}
async function fixture(manager: 'npm' | 'uvx' = 'npm') {
  const directory = await mkdtemp(join(tmpdir(), 'hub-packages-'));
  directories.push(directory);
  const npmCli = join(directory, 'npm-cli.js');
  await writeFile(npmCli, '// synthetic installer seam');
  const requests: Array<ProcessRequest & { cwd: string }> = [];
  const value = packaged(manager);
  const behavior = {
    fail: false,
    hold: undefined as Promise<void> | undefined,
    bin: 'bin/server.js',
    source: '// synthetic MCP entry',
    version: '1.2.3',
  };
  const protect = vi.fn(async () => undefined);
  const tools: PackageTools = {
    node: process.execPath,
    npmCli,
    uv: 'C:\\Synthetic\\uv.exe',
    protect,
    async runner(cwd) {
      return {
        async run(request) {
          requests.push({ ...request, cwd });
          await behavior.hold;
          if (behavior.fail)
            return {
              outcome: 'exited',
              exitCode: 1,
              stdout: 'SYNTHETIC_PRIVATE_INSTALLER_DETAIL',
              stderr: '',
            };
          if (request.signal.aborted)
            return {
              outcome: 'cancelled',
              exitCode: null,
              stdout: '',
              stderr: '',
            };
          if (manager === 'npm') {
            const root = join(cwd, 'node_modules', '@synthetic', 'mcp');
            await mkdir(join(root, 'bin'), { recursive: true });
            await writeFile(
              join(root, 'package.json'),
              JSON.stringify({
                name: value.package.name,
                version: behavior.version,
                bin: { 'synthetic-mcp': behavior.bin },
              }),
            );
            await writeFile(join(root, 'bin', 'server.js'), behavior.source);
            await writeFile(
              join(cwd, 'package-lock.json'),
              JSON.stringify({ lockfileVersion: 3 }),
            );
          } else if (request.arguments[0] === 'venv') {
            await mkdir(join(cwd, 'venv', 'Scripts'), { recursive: true });
            await writeFile(
              join(cwd, 'venv', 'Scripts', 'python.exe'),
              'SYNTHETIC_VENV',
            );
          } else {
            const dist = join(
              cwd,
              'venv',
              'Lib',
              'site-packages',
              'synthetic_mcp-1.2.3.dist-info',
            );
            await mkdir(dist, { recursive: true });
            await writeFile(
              join(dist, 'METADATA'),
              `Name: synthetic-mcp\nVersion: ${behavior.version}\n`,
            );
            await writeFile(
              join(dist, 'entry_points.txt'),
              '[console_scripts]\nsynthetic-mcp = synthetic_mcp:main\n',
            );
            await writeFile(
              join(cwd, 'venv', 'Scripts', 'synthetic-mcp.exe'),
              'SYNTHETIC_CONSOLE_LAUNCHER',
            );
          }
          return {
            outcome: 'exited',
            exitCode: 0,
            stdout: 'synthetic install complete',
            stderr: '',
          };
        },
      };
    },
  };
  return {
    directory,
    value,
    requests,
    protect,
    behavior,
    tools,
    runtime: createPackageRuntime(directory, tools),
  };
}

it.each([
  'latest',
  '^1.2.3',
  '~1.2.3',
  '*',
  '>=1.2.3',
  'git+https://example.test/repo',
  'file:../private',
  '1.2.3 --script=evil',
  'https://example.test/secret',
])('rejects unpinned or executable version input %s', (version) => {
  for (const manager of ['npm', 'uvx'] as const)
    expect(
      PackageSpecSchema.safeParse({
        manager,
        name: 'synthetic-mcp',
        entryPoint: 'synthetic-mcp',
        version,
      }).success,
    ).toBe(false);
});
it.each([
  '--package',
  '../private',
  'C:\\private',
  'https://example.test/pkg',
  'pkg;evil',
  'pkg name',
  'pkg@latest',
  'pkg==1.2.3',
])('rejects ambiguous package names %s', (name) => {
  for (const manager of ['npm', 'uvx'] as const)
    expect(
      PackageSpecSchema.safeParse({
        manager,
        name,
        version: '1.2.3',
        entryPoint: 'synthetic',
      }).success,
    ).toBe(false);
});
it('binds manager, package, exact version, executable and arguments into execution approval', () => {
  const value = packaged(),
    hash = definitionHash(value);
  for (const change of [
    { name: '@synthetic/other' },
    { version: '1.2.4' },
    { entryPoint: 'other' },
  ])
    expect(
      definitionHash({ ...value, package: { ...value.package, ...change } }),
    ).not.toBe(hash);
  expect(definitionHash({ ...value, arguments: ['different'] })).not.toBe(hash);
});
it.each(['npm', 'uvx'] as const)(
  'requires approval and explicit preparation before any %s installer runs',
  async (manager) => {
    const f = await fixture(manager),
      signal = AbortSignal.timeout(5000);
    await expect(f.runtime.prepare(f.value, signal)).rejects.toBeDefined();
    const unapproved = { ...f.value, trustApproval: null };
    await expect(
      f.runtime.prepare(unapproved, signal, true),
    ).rejects.toBeDefined();
    expect(f.requests).toEqual([]);
    expect(f.protect).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual(['npm-cli.js']);
  },
);
it('installs pinned npm through node/npm-cli, resolves bin without a shell, and reuses an integrity-checked cache', async () => {
  const f = await fixture(),
    signal = AbortSignal.timeout(5000);
  const first = await f.runtime.prepare(f.value, signal, true);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.executable).toBe(process.execPath);
  expect(f.requests[0]!.arguments).toEqual(
    expect.arrayContaining([
      f.tools.npmCli,
      'install',
      '--ignore-scripts',
      '--bin-links=false',
      '--workspaces=false',
      '@synthetic/mcp@1.2.3',
    ]),
  );
  expect(first.executable).toBe(process.execPath);
  expect(first.arguments[0]).toContain(
    join('node_modules', '@synthetic', 'mcp', 'bin', 'server.js'),
  );
  expect(first.arguments.slice(1)).toEqual(f.value.arguments);
  expect(first.arguments[0]).not.toContain('stage-');
  expect(await f.runtime.prepare(f.value, signal)).toEqual(first);
  expect(f.requests).toHaveLength(1);
  expect(
    (await readdir(join(f.directory, 'packages'))).some(
      (name) => name.endsWith('.lock') || name.startsWith('stage-'),
    ),
  ).toBe(false);
  await writeFile(first.arguments[0]!, 'SYNTHETIC_TAMPER');
  await expect(f.runtime.prepare(f.value, signal, true)).rejects.toBeDefined();
  expect(f.requests).toHaveLength(1);
});
it('installs a wheel-only Python package into a stable private venv and resolves its own console exe', async () => {
  const f = await fixture('uvx'),
    signal = AbortSignal.timeout(5000);
  const launch = await f.runtime.prepare(f.value, signal, true);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]!.arguments).toEqual(
    expect.arrayContaining([
      'venv',
      '--managed-python',
      '--no-config',
      '--no-project',
    ]),
  );
  expect(f.requests[1]!.arguments).toEqual(
    expect.arrayContaining([
      'pip',
      'install',
      '--only-binary',
      ':all:',
      'synthetic-mcp==1.2.3',
    ]),
  );
  expect(f.requests[1]!.arguments).not.toContain('--system');
  expect(launch.executable).toContain(
    join('venv', 'Scripts', 'synthetic-mcp.exe'),
  );
  expect(launch.executable).not.toContain('stage-');
  expect(launch.arguments).toEqual(f.value.arguments);
  expect(await f.runtime.prepare(f.value, signal)).toEqual(launch);
  expect(f.requests).toHaveLength(2);
});
it.each(['npm', 'uvx'] as const)(
  'isolates %s installer configuration and excludes provider secrets',
  async (manager) => {
    const f = await fixture(manager);
    f.value.secretBindings = { PROVIDER_TOKEN: 'wmh-secret-synthetic' };
    f.value.trustApproval!.definitionHash = definitionHash(f.value);
    const launch = await f.runtime.prepare(
      f.value,
      AbortSignal.timeout(5000),
      true,
    );
    for (const request of f.requests) {
      expect(request.environment).not.toHaveProperty('PROVIDER_TOKEN');
      expect(request.environment.HOME).toBe(
        join(f.directory, 'packages', 'home'),
      );
      for (const name of [
        'UV_CACHE_DIR',
        'UV_PYTHON_INSTALL_DIR',
        'UV_TOOL_DIR',
        'NPM_CONFIG_CACHE',
      ])
        expect(request.environment[name]).toContain(
          join(f.directory, 'packages'),
        );
      expect(request.environment.PATH).not.toContain('node_modules/.bin');
      expect(request.stdin).toBeUndefined();
    }
    expect(launch.environment.PYTHONNOUSERSITE).toBe('1');
  },
);
it.each(['npm', 'uvx'] as const)(
  'cleans failed/cancelled %s stages and its owned lock, without returning raw installer diagnostics',
  async (manager) => {
    const f = await fixture(manager);
    f.behavior.fail = true;
    try {
      await f.runtime.prepare(f.value, AbortSignal.timeout(5000), true);
      throw new Error('Unexpected success');
    } catch (error) {
      expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_INSTALLER_DETAIL');
    }
    const names = await readdir(join(f.directory, 'packages'));
    expect(
      names.some(
        (name) =>
          name.endsWith('.lock') ||
          name.startsWith('stage-') ||
          /^[a-f0-9]{64}$/.test(name),
      ),
    ).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.runtime.prepare(f.value, controller.signal, true),
    ).rejects.toBeDefined();
    expect(f.requests).toHaveLength(1);
  },
);
it('rejects escaping npm bins, mismatched versions and package cache links', async () => {
  const f = await fixture();
  f.behavior.bin = '../../../../outside.js';
  await expect(
    f.runtime.prepare(f.value, AbortSignal.timeout(5000), true),
  ).rejects.toBeDefined();
  f.behavior.bin = 'bin/server.js';
  f.behavior.version = '9.9.9';
  await expect(
    f.runtime.prepare(f.value, AbortSignal.timeout(5000), true),
  ).rejects.toBeDefined();
  f.behavior.version = '1.2.3';
  const launch = await f.runtime.prepare(
    f.value,
    AbortSignal.timeout(5000),
    true,
  );
  const file = launch.arguments[0]!,
    outside = join(f.directory, 'outside.js');
  await writeFile(outside, '// synthetic outside');
  await unlink(file);
  // A junction is available without symlink privileges on Windows.
  const target = dirname(file),
    moved = join(f.directory, 'outside-bin');
  await mkdir(moved);
  await writeFile(join(moved, 'server.js'), '// synthetic outside');
  await rm(target, { recursive: true });
  await symlink(moved, target, 'junction');
  await expect(
    f.runtime.prepare(f.value, AbortSignal.timeout(5000)),
  ).rejects.toBeDefined();
});
it('serializes installs with an exclusive owned lock rather than spawning a second installer', async () => {
  const f = await fixture();
  let release!: () => void;
  f.behavior.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.runtime.prepare(f.value, AbortSignal.timeout(5000), true);
  for (let i = 0; i < 100 && !f.requests.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  await expect(
    f.runtime.prepare(f.value, AbortSignal.timeout(5000), true),
  ).rejects.toBeDefined();
  release();
  await first;
  expect(f.requests).toHaveLength(1);
});
it('converts exact npx/uvx imports to package definitions while retaining unpinned commands as data only', () => {
  for (const [command, args, manager] of [
    ['npx', ['-y', '@synthetic/mcp@1.2.3', '--Case'], 'npm'],
    ['uvx', ['synthetic-mcp==1.2.3', '--Case'], 'uvx'],
  ] as const) {
    const draft = normalizeImport(JSON.stringify({ command, args }));
    try {
      expect(draft.entries[0]!.issues).toEqual([]);
      expect(draft.entries[0]!.definition).toMatchObject({
        executionMode: 'package',
        package: { manager, version: '1.2.3' },
        arguments: ['--Case'],
      });
    } finally {
      clearImport(draft);
    }
  }
  const draft = normalizeImport(
    JSON.stringify({ command: 'npx', args: ['synthetic-mcp@latest'] }),
  );
  try {
    expect(draft.entries[0]!.definition?.executionMode).toBe('native');
    expect(draft.entries[0]!.warnings).toContain('unpinned_package');
  } finally {
    clearImport(draft);
  }
});
it('forces packaged Chrome into an isolated browser without attaching personal profiles', () => {
  const value = packaged();
  value.package = {
    manager: 'npm',
    name: 'chrome-devtools-mcp',
    version: '1.2.3',
    entryPoint: 'chrome-devtools-mcp',
  };
  expect(packageArguments(value)).toContain('--isolated');
  value.arguments = ['--browser-url=http://localhost:9222'];
  expect(() => packageArguments(value)).toThrow();
});
it.each(['npx', 'uvx'] as const)(
  'manual %s save is reference-only and explicitly approved without any installer activity',
  async (type) => {
    const store = memoryStore(),
      secrets = memorySecrets();
    const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      secrets: { windows: secrets.backend },
    });
    const input = {
      expectedRevision: 0,
      name: `Synthetic ${type}`,
      type,
      packageName: 'synthetic-mcp',
      packageVersion: '1.2.3',
      env: { PROVIDER_TOKEN: 'SYNTHETIC PACKAGE PRIVATE VALUE' },
      approveExecution: true,
      autoSync: false,
      confirmSave: true,
    };
    try {
      expect(await addManualMcp(hub, input, 'owner')).toMatchObject({
        state: 'saved',
        requiresApproval: false,
      });
      expect(input.env.PROVIDER_TOKEN).toBe('');
      const saved = (await store.read()).connectors[0]!;
      expect(saved.executionMode).toBe('package');
      expect(saved.trustApproval!.definitionHash).toBe(definitionHash(saved));
      expect(saved.trustApproval!.risk).toBe('native_execution');
      expect(JSON.stringify(saved)).not.toContain(
        'SYNTHETIC PACKAGE PRIVATE VALUE',
      );
    } finally {
      await hub.close();
      secrets.close();
    }
  },
);

it.skipIf(process.platform !== 'win32')(
  'a prepared package runs contained and retains state through the persistent bridge',
  async () => {
    const f = await fixture();
    f.behavior.source = `
    const input=require('node:readline').createInterface({input:process.stdin});let count=0;
    input.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
      if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-package',version:'1'}};
      else if(m.method==='tools/list')result={tools:[{name:'tick',inputSchema:{type:'object'}}]};
      else result={content:[{type:'text',text:String(++count)}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `;
    await f.runtime.prepare(f.value, AbortSignal.timeout(5000), true);
    const state = emptyState();
    state.connectors = [f.value];
    let starts = 0;
    const bridge = createAgentBridge(
      async () => state,
      async (_connector, signal) => {
        const launch = await f.runtime.prepare(f.value, signal);
        starts++;
        const runner = await createWindowsProcessRunner({
          allowedExecutables: [launch.executable],
          workingDirectory: launch.workingDirectory,
        });
        const transport = new ContainedStdioTransport(
          runner,
          {
            executable: launch.executable,
            arguments: launch.arguments,
            environment: launch.environment,
            timeoutMs: 3_600_000,
            session: true,
            outputLimitBytes: 1024 * 1024,
          },
          signal,
        );
        const client = new Client(
          { name: 'synthetic-parent', version: '1' },
          { capabilities: {} },
        );
        try {
          await client.connect(transport, { timeout: 20_000 });
        } catch (error) {
          await transport.close();
          throw error;
        }
        return {
          client,
          assertPublic() {},
          async dispose() {
            try {
              await client.close();
            } finally {
              await transport.close();
            }
          },
        };
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    const agent = new Client(
      { name: 'synthetic-package-agent', version: '1' },
      { capabilities: {} },
    );
    await agent.connect(b);
    try {
      const tools = await agent.listTools();
      expect(tools.tools).toHaveLength(1);
      for (const text of ['1', '2'])
        expect(
          await agent.callTool({ name: tools.tools[0]!.name, arguments: {} }),
        ).toMatchObject({ content: [{ text }] });
      expect(starts).toBe(1);
      expect(f.requests).toHaveLength(1);
    } finally {
      await agent.close();
      await bridge.close();
    }
  },
  40_000,
);
