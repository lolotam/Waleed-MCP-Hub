import { describe, expect, it } from 'vitest';
import {
  createLifecycle,
  createMaterializer,
  createMemorySafetyLedger,
  managedProfileId,
  profileHash,
  type ManagedFiles,
  type DockerProfiles,
} from '@waleed/hub-core';
import { hashBytes } from '../packages/hub-core/src/runtime/registry.js';
import { MaterializationFault } from '../packages/hub-core/src/runtime/materialize.js';
import { apply, profileState } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';

export function materializationFixture() {
  const disk = new Map<string, string>();
  const profiles = new Map<string, string>();
  const writes: string[] = [];
  const commands: string[] = [];
  const files: ManagedFiles = {
    path(scope, name) {
      return `C:\\Synthetic\\${scope}\\${name}`;
    },
    async read(scope, name) {
      return disk.get(`${scope}:${name}`) ?? null;
    },
    async write(scope, name, expected, contents) {
      const key = `${scope}:${name}`;
      const current = disk.get(key) ?? null;
      if ((current === null ? null : hashBytes(current)) !== expected)
        throw new Error('Synthetic CAS mismatch.');
      writes.push(key);
      if (contents === null) disk.delete(key);
      else disk.set(key, contents);
    },
  };
  const docker: DockerProfiles = {
    async read(id) {
      commands.push(`read:${id}`);
      return profiles.get(id) ?? null;
    },
    async import(id, json) {
      commands.push(`import:${id}`);
      profiles.set(id, json);
    },
    async remove(id) {
      commands.push(`remove:${id}`);
      profiles.delete(id);
    },
  };
  const materializer = createMaterializer({
    files,
    docker,
    nodeExecutable: 'C:\\Synthetic\\node.exe',
    launcherModuleUrl: 'file:///C:/Synthetic/dist/runtime/launcher.js',
    registryPath: 'C:\\Synthetic\\state.json',
  });
  return { disk, profiles, writes, commands, files, docker, materializer };
}
const signal = () => new AbortController().signal;

describe('managed Docker snapshots and native launchers', () => {
  it('previews without writes, then materializes catalog files and exact profile snapshots with read-back', async () => {
    const fixture = materializationFixture();
    const state = profileState();
    const plan = await fixture.materializer.plan(
      state,
      'profile',
      false,
      signal(),
    );
    expect(fixture.writes).toEqual([]);
    expect(
      fixture.commands.every((command) => command.startsWith('read:')),
    ).toBe(true);
    expect(plan.record?.files).toHaveLength(2);
    expect(plan.record?.dockerProfileId).toBe(managedProfileId('profile'));
    const receipt = await fixture.materializer.apply(plan, signal());
    const profile = JSON.parse(
      fixture.profiles.get(managedProfileId('profile'))!,
    ) as {
      servers: Array<{ type: string; snapshot: { server: { name: string } } }>;
    };
    expect(profile.servers.map((server) => server.type)).toEqual([
      'remote',
      'image',
    ]);
    expect(
      fixture.commands.some((command) => /gateway|run|pull/.test(command)),
    ).toBe(false);
    expect(plan.record?.configurationHash).toBe(
      profileHash(state.profiles[0]!, state),
    );
    await receipt.rollback();
    expect(fixture.disk.size).toBe(0);
    expect(fixture.profiles.size).toBe(0);
  });
  it('generates independent native entry/manifest pairs from exact argument arrays, never interpolated shell programs', async () => {
    const fixture = materializationFixture();
    const state = profileState(['native']);
    const plan = await fixture.materializer.plan(
      state,
      'profile',
      false,
      signal(),
    );
    await fixture.materializer.apply(plan, signal());
    expect(fixture.profiles.size).toBe(0);
    expect(
      [...fixture.disk.keys()].every((key) => key.startsWith('runtime:wmh-')),
    ).toBe(true);
    const script = [...fixture.disk.entries()].find(([key]) =>
      key.endsWith('.mjs'),
    )![1];
    const manifest = JSON.parse(
      [...fixture.disk.entries()].find(([key]) => key.endsWith('.json'))![1],
    ) as { connector: { arguments: string[] } };
    expect(script).toContain('runNativeLauncher');
    expect(script).not.toContain('$(inert)');
    expect(script).not.toContain('cmd /c');
    expect(manifest.connector.arguments).toEqual([
      'fixture.js',
      'عربي',
      '"quotes"',
      '$(inert)',
    ]);
  });
  it('refuses unapproved definitions, private draft values, unsafe shims, unowned filenames and profile IDs', async () => {
    const fixture = materializationFixture();
    const state = profileState();
    state.connectors[0]!.trustApproval = null;
    await expect(
      fixture.materializer.plan(state, 'profile', false, signal()),
    ).rejects.toMatchObject({ code: 'conflict' });
    const secret = profileState();
    secret.connectors[0]!.headerBindings = { Authorization: 'ref' };
    const { definitionHash } = await import('@waleed/hub-core');
    secret.connectors[0]!.trustApproval!.definitionHash = definitionHash(
      secret.connectors[0]!,
    );
    await expect(
      fixture.materializer.plan(secret, 'profile', false, signal()),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const native = profileState(['native']);
    if (native.connectors[0]!.executionMode === 'native')
      native.connectors[0]!.executable = 'npx.cmd';
    native.connectors[0]!.trustApproval!.definitionHash = definitionHash(
      native.connectors[0]!,
    );
    await expect(
      fixture.materializer.plan(native, 'profile', false, signal()),
    ).rejects.toMatchObject({ code: 'unavailable' });
    fixture.profiles.set(
      managedProfileId('profile'),
      JSON.stringify({ id: managedProfileId('profile'), name: 'unowned' }),
    );
    await expect(
      fixture.materializer.plan(profileState(), 'profile', false, signal()),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects external drift before overwriting it and does not touch the existing pilot', async () => {
    const fixture = materializationFixture();
    const state = profileState();
    fixture.profiles.set('waleed-mcp-hub-pilot', 'SYNTHETIC-DO-NOT-TOUCH');
    const plan = await fixture.materializer.plan(
      state,
      'profile',
      false,
      signal(),
    );
    await fixture.materializer.apply(plan, signal());
    state.materializations = [plan.record!];
    state.profiles[0]!.dockerProfileId = plan.record!.dockerProfileId;
    const [name] = fixture.disk.keys();
    fixture.disk.set(name!, 'external-edit');
    await expect(
      fixture.materializer.plan(state, 'profile', false, signal()),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(fixture.disk.get(name!)).toBe('external-edit');
    expect(fixture.profiles.get('waleed-mcp-hub-pilot')).toBe(
      'SYNTHETIC-DO-NOT-TOUCH',
    );
  });
  it('rolls back an import that committed before reporting failure, with exact read-back', async () => {
    const fixture = materializationFixture();
    const original = fixture.docker.import;
    let fail = true;
    fixture.docker.import = async (...args) => {
      await original(...args);
      if (fail) {
        fail = false;
        throw new Error('Synthetic post-import failure.');
      }
    };
    const plan = await fixture.materializer.plan(
      profileState(),
      'profile',
      false,
      signal(),
    );
    await expect(
      fixture.materializer.apply(plan, signal()),
    ).rejects.toMatchObject({ restored: true });
    expect(fixture.disk.size).toBe(0);
    expect(fixture.profiles.size).toBe(0);
  });
  it('refuses a rollback over newer external state and leaves explicit recovery blocking', async () => {
    const fixture = materializationFixture();
    fixture.docker.import = async (id) => {
      fixture.profiles.set(id, JSON.stringify({ id, name: 'External change' }));
      throw new Error('Synthetic uncertain result.');
    };
    const ledger = createMemorySafetyLedger();
    const store = memoryStore(profileState());
    const hub = createLifecycle(store, Date.now, ledger, {
      materializer: fixture.materializer,
    });
    const job = await apply(hub, {
      kind: 'materialize_profile',
      profileId: 'profile',
    });
    expect(job.state).toBe('failed');
    expect((await ledger.read()).operations[0]?.phase).toBe('needs_review');
    expect(fixture.profiles.get(managedProfileId('profile'))).toContain(
      'External change',
    );
    await expect(
      hub.preview(
        {
          kind: 'set_profile_enabled',
          expectedRevision: 0,
          profileId: 'profile',
          enabled: false,
        },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('compensates external writes when registry commit fails, but never replays the operation', async () => {
    const fixture = materializationFixture();
    const store = memoryStore(profileState());
    store.write = async () => {
      throw new Error('Synthetic pre-commit failure.');
    };
    const ledger = createMemorySafetyLedger();
    const hub = createLifecycle(store, Date.now, ledger, {
      materializer: fixture.materializer,
    });
    expect(
      (await apply(hub, { kind: 'materialize_profile', profileId: 'profile' }))
        .state,
    ).toBe('failed');
    expect((await ledger.read()).operations[0]?.phase).toBe('aborted');
    expect(fixture.disk.size).toBe(0);
    expect(fixture.profiles.size).toBe(0);
  });
  it('dematerializes an owned snapshot before profile removal and marks existing bindings reconnect-required', async () => {
    const fixture = materializationFixture();
    const state = profileState();
    state.agentBindings = [
      {
        agentId: 'codex',
        profileId: 'profile',
        appliedRevision: 0,
        reconnectRequired: false,
      },
    ];
    const hub = createLifecycle(
      memoryStore(state),
      Date.now,
      createMemorySafetyLedger(),
      { materializer: fixture.materializer },
    );
    expect(
      (await apply(hub, { kind: 'materialize_profile', profileId: 'profile' }))
        .state,
    ).toBe('succeeded');
    expect((await hub.inventory()).materializations).toHaveLength(1);
    expect((await hub.inventory()).agentBindings?.[0]?.reconnectRequired).toBe(
      true,
    );
    await expect(
      hub.preview(
        { kind: 'remove_profile', profileId: 'profile', expectedRevision: 1 },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      (
        await apply(hub, {
          kind: 'dematerialize_profile',
          profileId: 'profile',
        })
      ).state,
    ).toBe('succeeded');
    expect(fixture.disk.size).toBe(0);
    expect(fixture.profiles.size).toBe(0);
    expect(
      (await apply(hub, { kind: 'remove_profile', profileId: 'profile' }))
        .state,
    ).toBe('succeeded');
  });
  it('records preparation before any external write, and allows running cancellation only for compensatable work', async () => {
    const fixture = materializationFixture();
    const ledger = createMemorySafetyLedger();
    const write = fixture.files.write;
    fixture.files.write = async (...args) => {
      expect((await ledger.read()).operations[0]?.phase).toBe('prepared');
      return write(...args);
    };
    const hub = createLifecycle(memoryStore(profileState()), Date.now, ledger, {
      materializer: fixture.materializer,
    });
    expect(
      (await apply(hub, { kind: 'materialize_profile', profileId: 'profile' }))
        .state,
    ).toBe('succeeded');
    expect((await ledger.read()).operations[0]?.external).toBe(true);
    expect(new MaterializationFault(false).restored).toBe(false);
  });
});
