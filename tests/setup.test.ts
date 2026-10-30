import { afterEach, expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  emptyState,
  approved,
} from '@waleed/hub-core';
import {
  ExportSetupBundleSchema,
  ImportSetupPreviewSchema,
  StateSchema,
  type ExportSetupBundle,
  type HubState,
} from '@waleed/contracts';
import {
  projectSetup,
  parseSetup,
} from '../packages/hub-core/src/setup/format.js';
import { profileState } from './helpers/runtime.js';
import { memoryStore } from './helpers/memory-store.js';
import { memorySecrets } from './helpers/secrets.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(state: HubState = emptyState(), now: () => number = Date.now) {
  const store = memoryStore(state),
    vault = memorySecrets(),
    safety = createMemorySafetyLedger(now),
    hub = createLifecycle(store, now, safety, {
      secrets: { windows: vault.backend },
    });
  cleanup.push(async () => {
    await hub.close();
    vault.close();
  });
  return { store, vault, safety, hub };
}
const bundle = () =>
  projectSetup(profileState(['native', 'remote', 'docker']), Date.now());
async function preview(
  f: ReturnType<typeof fixture>,
  source: ExportSetupBundle = bundle(),
  conflictStrategy: 'skip_existing' | 'overwrite_existing' = 'skip_existing',
  owner = 'owner',
) {
  return ImportSetupPreviewSchema.parse(
    await f.hub.setup.preview(
      { source: JSON.stringify(source), conflictStrategy },
      owner,
    ),
  );
}
async function apply(
  f: ReturnType<typeof fixture>,
  p: Awaited<ReturnType<typeof preview>>,
  credentials: Record<string, string> = {},
  owner = 'owner',
) {
  return f.hub.setup.apply(
    {
      previewId: p.id,
      expectedRevision: p.expectedRevision,
      conflictStrategy: p.conflictStrategy,
      credentials,
    },
    owner,
  );
}
it('exports a strict portable bundle and round-trips connectors, profiles, policy, overrides and assignments with no approval', async () => {
  const state = profileState(['native', 'remote', 'docker']);
  state.agentProfileBindings = { cursor: 'profile' };
  state.toolOverrides = [
    {
      connectorId: 'connector-0',
      originalToolName: 'read',
      alias: 'inspect_records',
      annotations: { readOnlyHint: true },
    },
  ];
  state.connectors[0]!.toolPolicies = { read: 'ask' };
  const source = fixture(state),
    exported = ExportSetupBundleSchema.parse(await source.hub.setup.export()),
    target = fixture();
  expect(exported.toolOverrides['connector-0/read']?.alias).toBe(
    'inspect_records',
  );
  const p = await preview(target, exported);
  expect(p.collisions).toEqual([]);
  expect(p.missingSecrets).toEqual([]);
  expect(await apply(target, p)).toMatchObject({
    state: 'saved',
    requiresApproval: true,
  });
  const restored = await target.hub.inventory();
  expect(
    restored.profiles.map(({ id, name, connectorIds }) => ({
      id,
      name,
      connectorIds,
    })),
  ).toEqual(
    state.profiles.map(({ id, name, connectorIds }) => ({
      id,
      name,
      connectorIds,
    })),
  );
  expect(restored.toolOverrides).toEqual(state.toolOverrides);
  expect(restored.agentProfileBindings).toEqual(state.agentProfileBindings);
  expect(restored.connectors[0]!.toolPolicies).toEqual({ read: 'ask' });
  expect(
    restored.connectors.every(
      (connector) => !approved(connector) && connector.trustApproval === null,
    ),
  ).toBe(true);
  expect((await target.safety.read()).operations).toMatchObject([
    { operation: 'import_setup', phase: 'committed', external: true },
  ]);
});
it('omits secret references, arbitrary environment values, OAuth bundles and encrypted receipts without reading them into the output', async () => {
  const state = profileState(['native', 'remote']);
  state.connectors[0]!.secretBindings = { API_KEY: 'wmh-secret-native' };
  state.connectors[0]!.environmentLiterals = {
    NODE_ENV: 'production',
    PRIVATE_ENV: 'SYNTHETIC-ENV-PRIVATE',
  };
  state.connectors[1]!.headerBindings = { Authorization: 'wmh-secret-oauth' };
  state.secretReferences = [
    {
      id: 'wmh-secret-native',
      adapter: 'windows',
      ownerIds: ['connector-0'],
      present: true,
      kind: 'credential',
    },
    {
      id: 'wmh-secret-oauth',
      adapter: 'windows',
      ownerIds: ['connector-1'],
      present: true,
      kind: 'oauth',
    },
  ];
  const f = fixture(state);
  f.vault.values.set('wmh-secret-native', Buffer.from('SYNTHETIC-KEY-PRIVATE'));
  f.vault.values.set(
    'wmh-secret-oauth',
    Buffer.from(
      JSON.stringify({
        accessToken: 'SYNTHETIC-ACCESS-PRIVATE',
        refreshToken: 'SYNTHETIC-REFRESH-PRIVATE',
        expiresAt: null,
      }),
    ),
  );
  const exported = await f.hub.setup.export(),
    text = JSON.stringify(exported);
  for (const secret of [
    'SYNTHETIC-ENV-PRIVATE',
    'SYNTHETIC-KEY-PRIVATE',
    'SYNTHETIC-ACCESS-PRIVATE',
    'SYNTHETIC-REFRESH-PRIVATE',
    'wmh-secret',
    'trustApproval',
    'secretReferences',
    'headerBindings',
  ])
    expect(text).not.toContain(secret);
  expect(exported.connectors[0]!.environmentLiterals).toEqual({
    NODE_ENV: 'production',
  });
  expect(
    exported.connectors[0]!.requiredSecrets.map((item) => item.key),
  ).toEqual(['API_KEY', 'PRIVATE_ENV']);
  expect(exported.connectors[1]!.requiredSecrets[0]).toMatchObject({
    key: 'Authorization',
    target: 'header',
    format: 'bearer',
  });
  expect(
    f.vault.reads.every((bytes) => bytes.every((value) => value === 0)),
  ).toBe(true);
});
it.each(['name', 'description', 'argument', 'profile', 'override', 'encoded'])(
  'refuses credential copies in %s, including copies across connectors and unowned references',
  async (location) => {
    const state = profileState(['native', 'remote']),
      secret = 'SYNTHETIC-LEAK-DO-NOT-EXPORT';
    state.secretReferences = [
      {
        id: 'wmh-secret-unused',
        adapter: 'windows',
        present: true,
        ownerIds: [],
      },
    ];
    if (location === 'name') state.connectors[1]!.name = secret;
    if (location === 'description') state.connectors[1]!.description = secret;
    if (
      location === 'argument' &&
      state.connectors[0]!.executionMode === 'native'
    )
      state.connectors[0]!.arguments.push(secret);
    if (location === 'profile') state.profiles[0]!.description = secret;
    if (location === 'override')
      state.toolOverrides = [
        {
          connectorId: 'connector-0',
          originalToolName: 'read',
          customDescription: secret,
        },
      ];
    if (location === 'encoded')
      state.profiles[0]!.description = Buffer.from(secret).toString('base64');
    const f = fixture(state);
    f.vault.values.set('wmh-secret-unused', Buffer.from(secret));
    await expect(f.hub.setup.export()).rejects.toHaveProperty(
      'code',
      'invalid',
    );
    expect(
      f.vault.reads.every((bytes) => bytes.every((value) => value === 0)),
    ).toBe(true);
  },
);
it('fails closed if a present protected credential cannot be inspected', async () => {
  const state = profileState(['native']);
  state.secretReferences = [
    {
      id: 'wmh-secret-unreadable',
      adapter: 'docker',
      present: true,
      ownerIds: [],
    },
  ];
  const f = fixture(state);
  await expect(f.hub.setup.export()).rejects.toHaveProperty(
    'code',
    'unavailable',
  );
});
it('previews required credentials and ID collisions, then skips existing connectors, overrides, profiles and assignments', async () => {
  const state = profileState(['native']);
  state.toolOverrides = [
    {
      connectorId: 'connector-0',
      originalToolName: 'read',
      alias: 'keep_local',
    },
  ];
  state.agentProfileBindings = { cursor: 'profile' };
  const f = fixture(state),
    incoming = bundle();
  incoming.connectors[0]!.requiredSecrets = [
    { key: 'API_KEY', target: 'environment', format: 'raw' },
  ];
  incoming.connectors[1]!.requiredSecrets = [
    { key: 'Authorization', target: 'header', format: 'bearer' },
  ];
  incoming.toolOverrides = {
    'connector-0/read': {
      connectorId: 'connector-0',
      originalToolName: 'read',
      alias: 'replace_remote',
    },
  };
  const p = await preview(f, incoming);
  expect(p.collisions).toEqual([
    { id: 'connector-0', kind: 'connector' },
    { id: 'profile', kind: 'profile' },
  ]);
  expect(p.connectors[0]!.action).toBe('skip');
  expect(p.missingSecrets.map((secret) => secret.inputKey)).toEqual([
    'connector-1/header/Authorization',
  ]);
  await apply(f, p, {
    'connector-1/header/Authorization': 'SYNTHETIC-RESTORED-AUTH',
  });
  const saved = await f.hub.inventory();
  expect(saved.connectors[0]).toEqual(state.connectors[0]);
  expect(saved.toolOverrides).toEqual(state.toolOverrides);
  expect(saved.profiles[0]!.connectorIds).toEqual(['connector-0']);
  expect(saved.agentProfileBindings).toEqual(state.agentProfileBindings);
});
it('protects every supplied credential before the single registry commit and retains old credentials on overwrite', async () => {
  const state = profileState(['native']);
  state.connectors[0]!.secretBindings = { OLD_KEY: 'old-reference' };
  state.secretReferences = [
    {
      id: 'old-reference',
      adapter: 'windows',
      present: true,
      ownerIds: ['connector-0'],
    },
  ];
  const f = fixture(state);
  f.vault.values.set('old-reference', Buffer.from('SYNTHETIC-OLD-PRIVATE'));
  const incoming = bundle();
  incoming.connectors[0]!.requiredSecrets = [
    { key: 'API_KEY', target: 'environment', format: 'raw' },
  ];
  incoming.connectors[1]!.requiredSecrets = [
    { key: 'Authorization', target: 'header', format: 'bearer' },
  ];
  incoming.agentProfileBindings = { cursor: 'profile' };
  const p = await preview(f, incoming, 'overwrite_existing');
  expect(p.connectors[0]!.action).toBe('overwrite');
  const write = f.store.write;
  let commits = 0;
  f.store.write = async (...args) => {
    commits++;
    expect(f.vault.values.size).toBe(3);
    return write(...args);
  };
  const credentials = {
    'connector-0/environment/API_KEY': 'SYNTHETIC-NEW-ENV-PRIVATE',
    'connector-1/header/Authorization': 'SYNTHETIC-NEW-HEADER-PRIVATE',
  };
  await apply(f, p, credentials);
  expect(Object.values(credentials)).toEqual(['', '']);
  expect(commits).toBe(1);
  const saved = StateSchema.parse(await f.hub.inventory()),
    id = saved.connectors.find((item) => item.id === 'connector-0')!
      .secretBindings.API_KEY!;
  expect(f.vault.values.get(id)!.toString()).toBe('SYNTHETIC-NEW-ENV-PRIVATE');
  expect(
    saved.secretReferences.find((item) => item.id === 'old-reference')!
      .ownerIds,
  ).toEqual([]);
  expect(f.vault.values.has('old-reference')).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('SYNTHETIC-NEW');
  expect(
    f.vault.writes.every((bytes) => bytes.every((value) => value === 0)),
  ).toBe(true);
  expect(
    f.vault.reads.every((bytes) => bytes.every((value) => value === 0)),
  ).toBe(true);
});
it.each(['missing', 'extra', 'echo'])(
  'rejects %s credentials without a vault write',
  async (kind) => {
    const f = fixture(),
      incoming = bundle();
    incoming.connectors[0]!.requiredSecrets = [
      { key: 'API_KEY', target: 'environment', format: 'raw' },
    ];
    if (kind === 'echo')
      incoming.profiles[0]!.description = 'SYNTHETIC-NEW-PRIVATE';
    const p = await preview(f, incoming);
    const credentials =
      kind === 'missing'
        ? {}
        : kind === 'extra'
          ? {
              'connector-0/environment/API_KEY': 'SYNTHETIC-NEW-PRIVATE',
              extra: 'SYNTHETIC-EXTRA-PRIVATE',
            }
          : { 'connector-0/environment/API_KEY': 'SYNTHETIC-NEW-PRIVATE' };
    await expect(apply(f, p, credentials)).rejects.toHaveProperty(
      'code',
      'invalid',
    );
    expect(f.vault.values.size).toBe(0);
    expect((await f.hub.inventory()).revision).toBe(0);
  },
);
it('makes previews owner-bound, single-use, revision-bound and expiring', async () => {
  let clock = Date.now();
  const f = fixture(emptyState(), () => clock),
    p = await preview(f);
  await expect(apply(f, p, {}, 'other')).rejects.toHaveProperty(
    'code',
    'not_found',
  );
  await apply(f, p);
  await expect(apply(f, p)).rejects.toHaveProperty('code', 'not_found');
  const second = await preview(f);
  clock += 300001;
  await expect(apply(f, second)).rejects.toHaveProperty('code', 'not_found');
  const third = await preview(f);
  const state = await f.store.read();
  state.revision++;
  await f.store.write(state.revision - 1, state);
  await expect(apply(f, third)).rejects.toHaveProperty('code', 'conflict');
});
it('bounds drafts, revokes on logout and cancels only owner previews', async () => {
  const f = fixture();
  const p = await preview(f);
  expect(() => f.hub.setup.cancel(p.id, 'other')).toThrow();
  f.hub.setup.cancel(p.id, 'owner');
  for (let i = 0; i < 8; i++) await preview(f);
  await expect(preview(f)).rejects.toHaveProperty('code', 'busy');
  f.hub.setup.revoke('owner');
  expect(await preview(f)).toHaveProperty('id');
});
it.each([
  'write_before',
  'write_after',
  'read_drift',
  'vault_partial',
  'rollback_failure',
  'readback_wrong',
])(
  'handles %s transaction failures without plaintext backup or uncertain rollback',
  async (mode) => {
    const f = fixture(),
      incoming = bundle();
    incoming.connectors[0]!.requiredSecrets = [
      { key: 'API_KEY', target: 'environment', format: 'raw' },
      { key: 'SECOND_KEY', target: 'environment', format: 'raw' },
    ];
    const p = await preview(f, incoming),
      originalWrite = f.store.write,
      originalPut = f.vault.backend.put;
    let writes = 0;
    if (mode === 'write_before')
      f.store.write = async () => {
        throw new Error('private backend failure');
      };
    if (mode === 'write_after')
      f.store.write = async (...args) => {
        await originalWrite(...args);
        throw new Error('private backend failure');
      };
    if (mode === 'read_drift')
      f.store.write = async (expected, next) => {
        const changed = structuredClone(next);
        changed.revision++;
        await originalWrite(expected, changed);
        throw new Error();
      };
    if (mode === 'vault_partial' || mode === 'rollback_failure')
      f.vault.backend.put = async (...args) => {
        await originalPut(...args);
        if (++writes === 2) throw new Error();
      };
    if (mode === 'rollback_failure')
      f.vault.backend.delete = async () => {
        throw new Error();
      };
    if (mode === 'readback_wrong')
      f.vault.backend.read = async () => Buffer.from('wrong-protected-value');
    const promise = apply(f, p, {
      'connector-0/environment/API_KEY': 'SYNTHETIC-FIRST-PRIVATE',
      'connector-0/environment/SECOND_KEY': 'SYNTHETIC-SECOND-PRIVATE',
    });
    if (mode === 'write_after') {
      expect(await promise).toMatchObject({ state: 'saved' });
      expect(f.vault.values.size).toBe(2);
    } else {
      await expect(promise).rejects.toHaveProperty('code', 'unavailable');
      if (mode === 'read_drift' || mode === 'rollback_failure') {
        expect((await f.safety.read()).operations[0]!.phase).toBe(
          'needs_review',
        );
        await expect(f.safety.assertWritable()).rejects.toHaveProperty(
          'code',
          'conflict',
        );
        expect(f.vault.values.size).toBe(2);
      } else {
        expect(f.vault.values.size).toBe(0);
        expect((await f.hub.inventory()).revision).toBe(0);
        expect((await f.safety.read()).operations[0]!.phase).toBe('aborted');
      }
    }
    expect(JSON.stringify(await f.safety.read())).not.toContain(
      'SYNTHETIC-FIRST-PRIVATE',
    );
    expect(
      f.vault.writes.every((bytes) => bytes.every((value) => value === 0)),
    ).toBe(true);
  },
);
it('does not start vault writes if the journal cannot prepare', async () => {
  const f = fixture(),
    incoming = bundle();
  incoming.connectors[0]!.requiredSecrets = [
    { key: 'API_KEY', target: 'environment', format: 'raw' },
  ];
  const p = await preview(f, incoming);
  f.safety.prepare = async () => {
    throw new Error();
  };
  await expect(
    apply(f, p, { 'connector-0/environment/API_KEY': 'SYNTHETIC-PRIVATE' }),
  ).rejects.toThrow();
  expect(f.vault.values.size).toBe(0);
});
it('returns a saved/recovery result if journal finalization fails, and blocks later mutations', async () => {
  const f = fixture(),
    p = await preview(f);
  f.safety.finish = async () => {
    throw new Error();
  };
  expect(await apply(f, p)).toMatchObject({
    state: 'saved',
    recoveryRequired: true,
  });
  await expect(f.safety.assertWritable()).rejects.toHaveProperty(
    'code',
    'conflict',
  );
});
it('refuses affected direct snapshots before writing any credentials', async () => {
  const state = profileState(['native']);
  state.materializations = [
    {
      profileId: 'profile',
      profileRevision: 1,
      configurationHash: '0'.repeat(64),
      files: [],
      dockerProfileId: null,
      dockerHash: null,
      appliedAt: new Date().toISOString(),
    },
  ];
  const f = fixture(state);
  await expect(
    preview(f, bundle(), 'overwrite_existing'),
  ).rejects.toHaveProperty('code', 'conflict');
  expect(f.vault.values.size).toBe(0);
});
it('refuses unsupported Docker-to-DPAPI credential conversion rather than saving an unusable or unprotected binding', async () => {
  const f = fixture(),
    incoming = bundle();
  incoming.connectors[2]!.requiredSecrets = [
    { key: 'API_KEY', target: 'environment', format: 'raw' },
  ];
  await expect(preview(f, incoming)).rejects.toHaveProperty(
    'code',
    'unavailable',
  );
  expect((await f.hub.inventory()).revision).toBe(0);
  expect(f.vault.values.size).toBe(0);
});
it('requires DPAPI, refuses decoded Basic echoes and accepts package definitions without installation', async () => {
  const f = fixture(),
    incoming = bundle();
  incoming.connectors[1]!.requiredSecrets = [
    { key: 'Authorization', target: 'header', format: 'basic' },
  ];
  incoming.profiles[0]!.description = 'SYNTHETIC-USER:SYNTHETIC-PASSWORD';
  const p = await preview(f, incoming);
  await expect(
    apply(f, p, {
      'connector-1/header/Authorization': Buffer.from(
        'SYNTHETIC-USER:SYNTHETIC-PASSWORD',
      ).toString('base64'),
    }),
  ).rejects.toHaveProperty('code', 'invalid');
  const noVault = createLifecycle(memoryStore());
  cleanup.push(() => noVault.close());
  const pp = await noVault.setup.preview(
    { source: JSON.stringify(incoming), conflictStrategy: 'skip_existing' },
    'owner',
  );
  await expect(
    noVault.setup.apply(
      {
        previewId: pp.id,
        expectedRevision: pp.expectedRevision,
        conflictStrategy: pp.conflictStrategy,
        credentials: {
          'connector-1/header/Authorization': 'SYNTHETIC-FRESH-CREDENTIAL',
        },
      },
      'owner',
    ),
  ).rejects.toHaveProperty('code', 'unavailable');
  const source = bundle(),
    entry = source.connectors[0]!;
  source.connectors[0] = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    enabled: entry.enabled,
    policies: entry.policies,
    requiredSecrets: [],
    environmentLiterals: {},
    type: 'package',
    package: {
      manager: 'npm',
      name: 'synthetic-mcp',
      version: '1.2.3',
      entryPoint: 'synthetic-mcp',
    },
    args: [],
  };
  await apply(f, await preview(f, source));
  expect((await f.hub.inventory()).connectors[0]).toMatchObject({
    executionMode: 'package',
    trustApproval: null,
    package: { version: '1.2.3' },
  });
});
it.each([
  'duplicate',
  'prototype',
  'traversal',
  'encoded_traversal',
  'url_credentials',
  'url_query',
  'bad_command',
  'unknown_field',
  'ciphertext',
  'credential_flag',
  'runtime_env',
  'annotation_secret',
  'dangling_profile',
  'override_identity',
  'oversized',
])('rejects malicious/corrupted setup: %s', (kind) => {
  const incoming = bundle();
  let source = '';
  if (kind === 'duplicate') {
    source = JSON.stringify(incoming).replace(
      '"version":1',
      '"version":1,"version":1',
    );
  }
  if (kind === 'prototype')
    source = JSON.stringify(incoming).replace(
      '"version":1',
      '"__proto__":{},"version":1',
    );
  const native = incoming.connectors[0]!,
    remote = incoming.connectors[1]!;
  if (native.type !== 'native' || remote.type !== 'remote') throw new Error();
  if (kind === 'traversal') native.args = ['..\\private.txt'];
  if (kind === 'encoded_traversal')
    remote.url = 'https://example.test/%252e%252e/private';
  if (kind === 'url_credentials')
    remote.url = 'https://user:password@example.test/mcp';
  if (kind === 'url_query') remote.url = 'https://example.test/mcp?key=private';
  if (kind === 'bad_command') native.command = 'node.exe && arbitrary';
  if (kind === 'unknown_field')
    Object.assign(native, { secretBindings: { KEY: 'cipher' } });
  if (kind === 'ciphertext') native.description = 'AQAAANCMnd8BFdERjHoAwE';
  if (kind === 'credential_flag') native.args = ['--api-key', 'private'];
  if (kind === 'runtime_env')
    native.requiredSecrets = [
      { key: 'NODE_OPTIONS', target: 'environment', format: 'raw' },
    ];
  if (kind === 'annotation_secret')
    incoming.toolOverrides = {
      'connector-0/read': {
        connectorId: 'connector-0',
        originalToolName: 'read',
        annotations: { accessToken: 'unknown-secret-value' },
      },
    };
  if (kind === 'dangling_profile')
    incoming.profiles[0]!.connectorIds = ['missing'];
  if (kind === 'override_identity')
    incoming.toolOverrides = {
      bad: {
        connectorId: 'connector-0',
        originalToolName: 'read',
        alias: 'test',
      },
    };
  if (kind === 'oversized') source = ' '.repeat(524289);
  expect(() => parseSetup(source || JSON.stringify(incoming))).toThrow();
});
