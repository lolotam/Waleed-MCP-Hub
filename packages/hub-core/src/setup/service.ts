import { randomUUID } from 'node:crypto';
import {
  ConnectorSchema,
  StateSchema,
  ImportSetupPreviewRequestSchema,
  ImportSetupApplyRequestSchema,
  ImportSetupPreviewSchema,
  setupCredentialKey,
  type HubState,
  type ExportSetupBundle,
  type ImportSetupPreview,
  type SetupConflictStrategy,
} from '@waleed/contracts';
import type { StateStore } from '../state.js';
import { stateHash, type SafetyLedger } from '../safety.js';
import type { MutationLock } from '../auth/credentials.js';
import { assertSecretValue, type SecretBackends } from '../auth/secrets.js';
import { HubError } from '../errors.js';
import { hashData } from '../runtime/registry.js';
import { assertToolOverrideCollisions } from '../integrations/tool-overrides.js';
import {
  parseSetup,
  projectSetup,
  validateSetup,
  assertSetupConfidential,
} from './format.js';

const conflict = () =>
  new HubError(
    'conflict',
    'Setup or inventory changed. Upload and review a new preview before applying.',
  );
const fold = (value: string) => value.trim().normalize('NFKC').toLowerCase();
function selection(
  bundle: ExportSetupBundle,
  state: HubState,
  strategy: SetupConflictStrategy,
) {
  const summarize = (
    items: Array<{ id: string; name: string }>,
    current: Array<{ id: string }>,
  ) =>
    items.map((item) => ({
      ...item,
      action: current.some((existing) => existing.id === item.id)
        ? strategy === 'skip_existing'
          ? ('skip' as const)
          : ('overwrite' as const)
        : ('add' as const),
    }));
  return {
    connectors: summarize(
      bundle.connectors.map(({ id, name }) => ({ id, name })),
      state.connectors,
    ),
    profiles: summarize(
      bundle.profiles.map(({ id, name }) => ({ id, name })),
      state.profiles,
    ),
  };
}
function plan(
  bundle: ExportSetupBundle,
  state: HubState,
  strategy: SetupConflictStrategy,
  time: string,
  operationId: string,
  nativeAdapter: NativeSecretAdapter,
) {
  const summary = selection(bundle, state, strategy),
    connectorIds = new Set(
      summary.connectors
        .filter((item) => item.action !== 'skip')
        .map((item) => item.id),
    ),
    profileIds = new Set(
      summary.profiles
        .filter((item) => item.action !== 'skip')
        .map((item) => item.id),
    ),
    next = structuredClone(state);
  if (
    bundle.connectors.some(
      (entry) =>
        connectorIds.has(entry.id) &&
        entry.type === 'docker' &&
        entry.requiredSecrets.length,
    )
  )
    throw new HubError(
      'unavailable',
      'Docker credential bindings require the Docker-managed vault. Import a credential-free Docker definition and bind Docker credentials separately; setup import never weakens the reference-only gateway.',
    );
  // Existing direct snapshots can retain obsolete credentials/policies. Refuse
  // before any vault write instead of pretending the registry controls them.
  if (
    state.materializations?.some(
      (record) =>
        profileIds.has(record.profileId) ||
        state.profiles.some(
          (profile) =>
            profile.id === record.profileId &&
            profile.connectorIds.some((id) => connectorIds.has(id)),
        ) ||
        record.files.some((file) =>
          [...connectorIds].some((id) =>
            file.name.endsWith(`-${hashData(id).slice(0, 16)}.json`),
          ),
        ),
    )
  )
    throw new HubError(
      'conflict',
      'Dematerialize affected direct profile snapshots before importing a setup.',
    );
  const missingSecrets: ImportSetupPreview['missingSecrets'] = [];
  for (const entry of bundle.connectors) {
    if (!connectorIds.has(entry.id)) continue;
    const prior = next.connectors.find((item) => item.id === entry.id),
      secretBindings: Record<string, string> = {},
      headerBindings: Record<string, string> = {},
      credentialFormats: Record<string, 'raw' | 'bearer' | 'basic'> = {};
    for (const secret of entry.requiredSecrets) {
      const secretId = `wmh-secret-${randomUUID()}`;
      (secret.target === 'environment' ? secretBindings : headerBindings)[
        secret.key
      ] = secretId;
      if (secret.target === 'header')
        credentialFormats[secret.key] = secret.format;
      next.secretReferences.push({
        id: secretId,
        adapter: nativeAdapter,
        present: true,
        ownerIds: [entry.id],
        kind: 'credential',
      });
      missingSecrets.push({
        ...secret,
        connectorId: entry.id,
        inputKey: setupCredentialKey(entry.id, secret),
      });
    }
    const common = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      enabled: entry.enabled,
      toolPolicies: entry.policies,
      environmentLiterals: entry.environmentLiterals,
      secretBindings,
      headerBindings,
      credentialFormats,
      trustApproval: null,
      revision: prior ? prior.revision + 1 : 1,
      createdAt: prior?.createdAt ?? time,
      updatedAt: time,
    };
    const connector = ConnectorSchema.parse(
      entry.type === 'remote'
        ? {
            ...common,
            executionMode: 'remote',
            transport: entry.transport,
            endpoint: entry.url,
            ...(entry.localHttpOptIn !== undefined
              ? { localHttpOptIn: entry.localHttpOptIn }
              : {}),
          }
        : entry.type === 'native'
          ? {
              ...common,
              executionMode: 'native',
              transport: 'stdio',
              executable: entry.command,
              arguments: entry.args,
            }
          : entry.type === 'docker'
            ? {
                ...common,
                executionMode: 'docker',
                transport: 'stdio',
                image: entry.image,
                command: entry.command,
                arguments: entry.args,
                ...(entry.portBindings
                  ? { portBindings: entry.portBindings }
                  : {}),
              }
            : {
                ...common,
                executionMode: 'package',
                transport: 'stdio',
                package: entry.package,
                arguments: entry.args,
              },
    );
    next.connectors = next.connectors.filter((item) => item.id !== entry.id);
    next.connectors.push(connector);
  }
  for (const entry of bundle.profiles)
    if (profileIds.has(entry.id)) {
      const prior = next.profiles.find((item) => item.id === entry.id);
      next.profiles = next.profiles.filter((item) => item.id !== entry.id);
      next.profiles.push({
        ...entry,
        revision: prior ? prior.revision + 1 : 1,
        dockerProfileId: null,
        updatedAt: time,
      });
    }
  for (const profile of next.profiles)
    if (
      !profileIds.has(profile.id) &&
      profile.connectorIds.some((id) => connectorIds.has(id))
    ) {
      profile.revision++;
      profile.updatedAt = time;
      profileIds.add(profile.id);
    }
  next.toolOverrides = [
    ...(state.toolOverrides ?? []).filter(
      (item) => !connectorIds.has(item.connectorId),
    ),
    ...Object.values(bundle.toolOverrides).filter((item) =>
      connectorIds.has(item.connectorId),
    ),
  ];
  next.agentProfileBindings = { ...state.agentProfileBindings };
  for (const [agent, id] of Object.entries(bundle.agentProfileBindings))
    if (
      strategy === 'overwrite_existing' ||
      !Object.hasOwn(next.agentProfileBindings, agent)
    )
      Object.assign(next.agentProfileBindings, { [agent]: id });
  for (const binding of next.agentBindings ?? [])
    if (profileIds.has(binding.profileId)) binding.reconnectRequired = true;
  for (const reference of next.secretReferences) {
    const owners = new Set(
      reference.ownerIds.filter((id) => !connectorIds.has(id)),
    );
    for (const connector of next.connectors)
      if (
        connectorIds.has(connector.id) &&
        [
          ...Object.values(connector.secretBindings),
          ...Object.values(connector.headerBindings),
        ].includes(reference.id)
      )
        owners.add(connector.id);
    reference.ownerIds = [...owners];
  }
  for (const items of [next.connectors, next.profiles])
    if (new Set(items.map((item) => fold(item.name))).size !== items.length)
      throw new HubError(
        'conflict',
        'Setup names collide with other identifiers. Rename entries before importing.',
      );
  assertToolOverrideCollisions(next);
  next.revision++;
  next.activity.push({
    id: operationId,
    time,
    operation: 'import_setup',
    targetId: 'setup',
    priorRevision: state.revision,
    newRevision: next.revision,
    result: 'succeeded',
  });
  next.activity = next.activity.slice(-200);
  return { next: StateSchema.parse(next), missingSecrets, connectorIds };
}
export function createSetupService(
  store: StateStore,
  safety: SafetyLedger,
  lock: MutationLock,
  backends: SecretBackends,
  invalidate: (ids: string[]) => void,
  now = Date.now,
) {
  const drafts = new Map<
    string,
    {
      owner: string;
      expires: number;
      bundle: ExportSetupBundle;
      preview: ImportSetupPreview;
      beforeHash: string;
    }
  >();
  let closed = false;
  const prune = () => {
    for (const [id, entry] of drafts)
      if (entry.expires <= now()) drafts.delete(id);
  };
  const timer = setInterval(prune, 30_000);
  timer.unref();
  const available = () => {
    if (closed) throw new HubError('unavailable', 'Setup service is closed.');
  };
  return {
    async export() {
      available();
      return lock(async () => {
        await safety.assertWritable();
        const state = await store.read(),
          bundle = validateSetup(projectSetup(state, now()));
        await assertSetupConfidential(bundle, state, backends);
        if (stateHash(await store.read()) !== stateHash(state))
          throw conflict();
        return bundle;
      });
    },
    async preview(raw: unknown, owner: string): Promise<ImportSetupPreview> {
      available();
      prune();
      if (drafts.size >= 8)
        throw new HubError(
          'busy',
          'Discard an existing setup preview before uploading.',
        );
      const input = ImportSetupPreviewRequestSchema.parse(raw),
        bundle = parseSetup(input.source);
      await safety.assertWritable();
      const state = await store.read();
      await assertSetupConfidential(bundle, state, backends);
      const selected = selection(bundle, state, input.conflictStrategy),
        planned = plan(
          bundle,
          state,
          input.conflictStrategy,
          new Date(now()).toISOString(),
          randomUUID(),
          nativeSecretAdapter(backends),
        ),
        id = randomUUID(),
        expires = now() + 5 * 60_000;
      const preview = ImportSetupPreviewSchema.parse({
        id,
        expectedRevision: state.revision,
        expiresAt: new Date(expires).toISOString(),
        conflictStrategy: input.conflictStrategy,
        ...selected,
        bundle,
        collisions: [
          ...selected.connectors
            .filter((item) => item.action !== 'add')
            .map((item) => ({ id: item.id, kind: 'connector' })),
          ...selected.profiles
            .filter((item) => item.action !== 'add')
            .map((item) => ({ id: item.id, kind: 'profile' })),
        ],
        missingSecrets: planned.missingSecrets,
        warnings: [
          'Imported connectors require new execution approval. Nothing is executed or written to agent files.',
          'Skip preserves existing entries, overrides and agent assignments. Overwrite replaces matching IDs and supplied assignments.',
          'Old vault credentials are retained. New credentials are protected with Windows DPAPI.',
          'Local commands, paths and MCPB installations must exist on the destination; installation receipts and OAuth accounts are not transferred.',
        ],
      });
      // Recheck after awaits so concurrent requests cannot exceed the bound.
      available();
      prune();
      if (drafts.size >= 8)
        throw new HubError('busy', 'Setup preview limit reached.');
      drafts.set(id, {
        owner,
        expires,
        bundle,
        preview,
        beforeHash: stateHash(state),
      });
      return structuredClone(preview);
    },
    cancel(id: string, owner: string) {
      const entry = drafts.get(id);
      if (entry?.owner !== owner)
        throw new HubError('not_found', 'Setup preview not found.');
      drafts.delete(id);
      return { discarded: true };
    },
    revoke(owner: string) {
      for (const [id, entry] of drafts)
        if (entry.owner === owner) drafts.delete(id);
    },
    async apply(raw: unknown, owner: string) {
      let input:
        ReturnType<typeof ImportSetupApplyRequestSchema.parse> | undefined;
      const buffers: Buffer[] = [];
      try {
        available();
        input = ImportSetupApplyRequestSchema.parse(raw);
        prune();
        const draft = drafts.get(input.previewId);
        if (!draft || draft.owner !== owner)
          throw new HubError(
            'not_found',
            'Setup preview is missing or expired.',
          );
        if (
          input.expectedRevision !== draft.preview.expectedRevision ||
          input.conflictStrategy !== draft.preview.conflictStrategy
        )
          throw conflict();
        drafts.delete(input.previewId);
        return await lock(async () => {
          await safety.assertWritable();
          const state = await store.read();
          if (
            state.revision !== input!.expectedRevision ||
            stateHash(state) !== draft.beforeHash
          )
            throw conflict();
          const operationId = randomUUID(),
            time = new Date(now()).toISOString(),
            planned = plan(
              draft.bundle,
              state,
              input!.conflictStrategy,
              time,
              operationId,
              nativeSecretAdapter(backends),
            ),
            backend = backends[nativeSecretAdapter(backends)];
          const keys = Object.keys(input!.credentials),
            required = planned.missingSecrets;
          if (
            keys.length !== required.length ||
            required.some(
              (secret) => !Object.hasOwn(input!.credentials, secret.inputKey),
            )
          )
            throw new HubError(
              'invalid',
              'Supply exactly the credentials requested by this setup preview.',
            );
          if (required.length && !backend?.read)
            throw new HubError(
              'unavailable',
              'Windows DPAPI is required to import credentials.',
            );
          const writes = required.map((secret) => {
            const bytes = Buffer.from(
              input!.credentials[secret.inputKey]!,
              'utf8',
            );
            buffers.push(bytes);
            assertSecretValue(bytes);
            const connector = planned.next.connectors.find(
              (item) => item.id === secret.connectorId,
            )!;
            const id = (
              secret.target === 'environment'
                ? connector.secretBindings
                : connector.headerBindings
            )[secret.key]!;
            return { id, bytes };
          });
          await assertSetupConfidential(
            draft.bundle,
            state,
            backends,
            writes.flatMap((write, index) => {
              const text = write.bytes.toString('utf8');
              return required[index]?.format === 'basic'
                ? [text, `Basic ${text}`]
                : [text];
            }),
          );
          for (const write of writes)
            if (await backend!.has(write.id, AbortSignal.timeout(10_000)))
              throw conflict();
          const beforeHash = stateHash(state),
            afterHash = stateHash(planned.next);
          await safety.prepare({
            id: operationId,
            operation: 'import_setup',
            targetId: 'setup',
            expectedRevision: state.revision,
            beforeHash,
            afterHash,
            phase: 'prepared',
            reason: 'none',
            createdAt: time,
            updatedAt: time,
            external: true,
          });
          const attempted: string[] = [];
          let committed = false;
          try {
            for (const write of writes) {
              attempted.push(write.id);
              await backend!.put(
                write.id,
                write.bytes,
                AbortSignal.timeout(20_000),
              );
              const actual = await backend!.read!(
                write.id,
                AbortSignal.timeout(10_000),
              );
              try {
                if (!actual.equals(write.bytes)) throw new Error();
              } finally {
                actual.fill(0);
              }
            }
            await store.write(state.revision, planned.next);
            if (stateHash(await store.read()) !== afterHash) throw new Error();
            committed = true;
          } catch {
            try {
              const actual = stateHash(await store.read());
              if (actual === afterHash) committed = true;
              else {
                if (actual !== beforeHash) throw new Error();
                for (const id of attempted) {
                  await backend!.delete(id, AbortSignal.timeout(15_000));
                  if (await backend!.has(id, AbortSignal.timeout(10_000)))
                    throw new Error();
                }
                await safety.finish(operationId, 'aborted', 'commit_failed');
              }
            } catch {
              await safety
                .finish(operationId, 'needs_review', 'state_drift')
                .catch(() => undefined);
              throw new HubError(
                'unavailable',
                'Setup import needs recovery review. Do not retry the import.',
              );
            }
            if (!committed)
              throw new HubError(
                'unavailable',
                'Setup import failed and was rolled back. Upload a new preview before retrying.',
              );
          }
          invalidate([...planned.connectorIds]);
          let recoveryRequired = false;
          try {
            await safety.finish(operationId, 'committed');
          } catch {
            recoveryRequired = true;
          }
          return {
            state: 'saved' as const,
            revision: planned.next.revision,
            requiresApproval: true,
            recoveryRequired,
          };
        });
      } finally {
        for (const bytes of buffers) bytes.fill(0);
        for (const source of [input, raw])
          if (
            source &&
            typeof source === 'object' &&
            'credentials' in source &&
            source.credentials &&
            typeof source.credentials === 'object'
          )
            for (const key of Object.keys(source.credentials))
              (source.credentials as Record<string, unknown>)[key] = '';
      }
    },
    close() {
      closed = true;
      clearInterval(timer);
      drafts.clear();
    },
  };
}
import { nativeSecretAdapter } from '../auth/secrets.js';
import type { NativeSecretAdapter } from '@waleed/contracts';
