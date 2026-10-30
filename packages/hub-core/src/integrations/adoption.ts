import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentImportPreviewSchema,
  ImportApplySchema,
  StateSchema,
  type ImportDefinition,
  type IntegrationAgentId,
} from '@waleed/contracts';
import type { StateStore } from '../state.js';
import { stateHash, type SafetyLedger } from '../safety.js';
import type { MutationLock } from '../auth/credentials.js';
import type { SecretBackends } from '../auth/secrets.js';
import { assertSecretValue } from '../auth/secrets.js';
import { nativeSecretAdapter } from '../auth/secrets.js';
import { assertBinding } from '../auth/bindings.js';
import { HubError } from '../errors.js';
import { createImportService } from '../imports/service.js';
import { clearImport, type PrivateImport } from '../imports/normalize.js';
import {
  hashBytes,
  hashData,
  planRegistry,
  requireProfile,
} from '../runtime/registry.js';
import { assertNoCredentialEcho } from './bridge.js';
import {
  agentEntry,
  editAgentDocument,
  managedEntry,
  parseAgentDocument,
} from './formats.js';
import { readAgentServers, removeAgentServers } from './adoption-formats.js';
import type { IntegrationAdapters } from './engine.js';

export function createAdoptionEngine(
  store: StateStore,
  safety: SafetyLedger,
  lock: MutationLock,
  backends: SecretBackends,
  adapters: IntegrationAdapters | undefined,
  invalidate: (ids: string[]) => void,
  now: () => number = Date.now,
) {
  const nativeAdapter = nativeSecretAdapter(backends);
  const enabled = !!backends[nativeAdapter]?.read;
  const sources = new Map<
    string,
    {
      agentId: IntegrationAgentId;
      path: string;
      fingerprint: string;
      keys: string[];
    }
  >();
  const imports = createImportService(now, enabled, (id) => {
    sources.delete(id);
  });
  return {
    enabled,
    imports,
    async preview(agentId: IntegrationAgentId, raw: unknown, owner: string) {
      const input = AgentImportPreviewSchema.parse(raw);
      await safety.assertWritable();
      const state = await store.read();
      if (state.revision !== input.expectedRevision)
        throw new HubError(
          'conflict',
          'Registry changed. Refresh before importing.',
        );
      const target = adapters?.targets.find((target) => target.id === agentId);
      if (!target || target.blocked)
        throw new HubError(
          'unavailable',
          'Agent import target is unavailable or ambiguous.',
        );
      const existing = [];
      for (const path of target.paths) {
        const text = await adapters!.files.read(path);
        if (text !== null) existing.push({ path, text });
      }
      if (existing.length !== 1)
        throw new HubError(
          'conflict',
          'Exactly one existing agent configuration is required.',
        );
      const source = existing[0]!,
        parsed = readAgentServers(source.text, target.format);
      const preview = imports.preview(
        { expectedRevision: state.revision, source: parsed.source },
        owner,
        state,
        false,
      );
      // Only fingerprints and source keys survive here, never the raw config.
      sources.set(preview.id, {
        agentId,
        path: source.path,
        fingerprint: hashBytes(source.text),
        keys: parsed.keys,
      });
      return {
        ...preview,
        agentSource: { agentId, fingerprint: hashBytes(source.text) },
        applyEffects: {
          agentConfiguration: true,
          encryptedRecoveryCopy: true,
          executionApproved: false,
        },
      };
    },
    async apply(id: string, raw: unknown, owner: string) {
      const input = ImportApplySchema.parse(raw);
      if (!enabled)
        throw new HubError(
          'unavailable',
          'Current-user DPAPI storage is required for import apply.',
        );
      return lock(async () => {
        await safety.assertWritable();
        const before = await store.read();
        if (before.revision !== input.expectedRevision)
          throw new HubError(
            'conflict',
            'Registry changed. Create a fresh import preview.',
          );
        const source = sources.get(id);
        if (source && !input.confirmAgentConfigChange)
          throw new HubError(
            'invalid',
            'Confirm replacement of selected agent entries by the Hub bridge.',
          );
        for (const profileId of input.profileIds)
          if (requireProfile(before, profileId).enabled === false)
            throw new HubError('invalid', 'Choose enabled Hub profiles.');
        const preview = imports.read(id, owner, before, false);
        const selected = preview.entries.filter((entry) => entry.selected);
        const target =
          source &&
          adapters?.targets.find((target) => target.id === source.agentId);
        let sourceText: string | null = null,
          afterText: string | null = null;
        if (source) {
          if (!target || target.blocked)
            throw new HubError(
              'unavailable',
              'Agent import target is unavailable.',
            );
          // Recheck all candidate paths: a new alternate file is also scope drift.
          for (const path of target.paths) {
            const text = await adapters!.files.read(path);
            if (path === source.path) sourceText = text;
            else if (text !== null)
              throw new HubError(
                'conflict',
                'Agent scope changed. Scan again.',
              );
          }
          if (
            sourceText === null ||
            hashBytes(sourceText) !== source.fingerprint
          )
            throw new HubError(
              'conflict',
              'Agent file changed since preview. No data was imported.',
            );
          const names = selected.map(
            (entry) => source.keys[Number(entry.key.slice(6)) - 1]!,
          );
          const stripped = removeAgentServers(sourceText, target.format, names);
          const record = before.integrations?.find(
            (record) => record.agentId === source.agentId,
          );
          afterText = editAgentDocument(
            stripped,
            target.format,
            agentEntry(
              target.format,
              adapters!.node,
              adapters!.bridge ??
                fileURLToPath(new URL('./bridge.js', import.meta.url)),
              adapters!.registry,
              source.agentId,
            ),
            record?.entryHash,
          );
        }
        let draft: PrivateImport | undefined;
        const values = new Map<string, Buffer>(),
          written: string[] = [];
        const backend = backends[nativeAdapter]!;
        const effectSignal = AbortSignal.timeout(120_000);
        let prepared = false,
          mutatedFile = false,
          committed = false,
          uncertainVault = false;
        const jobId = randomUUID(),
          manifestId = `wmh-secret-${randomUUID()}`;
        try {
          draft = imports.take(id, owner, before, false);
          sources.delete(id);
          const definitions: ImportDefinition[] = selected.map((entry) =>
            structuredClone(entry.definition!),
          );
          const secretIds = new Map<string, string>();
          for (const definition of definitions) {
            if (definition.executionMode === 'docker')
              throw new HubError(
                'invalid',
                'Agent import currently supports DPAPI-backed packages, native programs and remote servers, not Docker credentials.',
              );
            if (
              definition.executionMode === 'native' &&
              !/^[a-z]:[\\/].+\.exe$/i.test(definition.executable)
            )
              throw new HubError(
                'invalid',
                'Pin npx/uvx packages to an exact version or choose an absolute native .exe before importing.',
              );
            for (const location of ['environment', 'header'] as const)
              for (const [name, draftId] of Object.entries(
                location === 'environment'
                  ? definition.secretBindings
                  : definition.headerBindings,
              )) {
                assertBinding(location, name, 'raw');
                const bytes = draft.secrets.get(draftId);
                if (!bytes)
                  throw new HubError(
                    'invalid',
                    'Private credential draft is unavailable.',
                  );
                assertSecretValue(bytes);
                const id = `wmh-secret-${randomUUID()}`;
                secretIds.set(draftId, id);
                values.set(id, Buffer.from(bytes));
                (location === 'environment'
                  ? definition.secretBindings
                  : definition.headerBindings)[name] = id;
              }
            if (definition.executionMode === 'remote')
              definition.credentialFormats = Object.fromEntries(
                Object.keys(definition.headerBindings).map((name) => [
                  name,
                  'raw' as const,
                ]),
              );
          }
          if (afterText !== null) {
            try {
              assertNoCredentialEcho(
                parseAgentDocument(
                  afterText.replace(/^\uFEFF/, ''),
                  target!.format,
                ),
                [...values.values()].map((value) => value.toString('utf8')),
              );
              assertNoCredentialEcho(
                afterText,
                [...values.values()].map((value) => value.toString('utf8')),
              );
            } catch {
              throw new HubError(
                'invalid',
                'A selected credential also occurs outside the removable entries. Remove that duplicate before importing.',
              );
            }
          }
          const next = structuredClone(before),
            timestamp = new Date(now()).toISOString();
          for (const [id] of values)
            next.secretReferences.push({
              id,
              adapter: nativeAdapter,
              present: true,
              ownerIds: [],
              kind: 'credential',
            });
          const plan = planRegistry(
            {
              kind: 'create_connectors',
              expectedRevision: before.revision,
              definitions,
            },
            next,
            definitions[0]!.id,
            timestamp,
          );
          const final = plan.next;
          for (const profileId of input.profileIds) {
            const profile = requireProfile(final, profileId);
            profile.connectorIds.push(
              ...definitions.map((definition) => definition.id),
            );
            profile.revision++;
            profile.updatedAt = timestamp;
            for (const binding of final.agentBindings ?? [])
              if (binding.profileId === profileId)
                binding.reconnectRequired = true;
          }
          const backupIds: string[] = [];
          if (source && sourceText !== null) {
            const bytes = Buffer.from(sourceText, 'utf8');
            try {
              for (let offset = 0; offset < bytes.length; offset += 8192) {
                const id = `wmh-secret-${randomUUID()}`;
                backupIds.push(id);
                values.set(
                  id,
                  Buffer.from(bytes.subarray(offset, offset + 8192)),
                );
              }
            } finally {
              bytes.fill(0);
            }
            const manifest = Buffer.from(
              JSON.stringify({
                version: 1,
                agentId: source.agentId,
                sourceHash: source.fingerprint,
                afterHash: hashBytes(afterText!),
                chunks: backupIds,
                credentialIds: [...secretIds.values()],
                connectorIds: definitions.map((definition) => definition.id),
              }),
            );
            values.set(manifestId, manifest);
            assertSecretValue(manifest);
            backupIds.push(manifestId);
            for (const id of backupIds)
              final.secretReferences.push({
                id,
                adapter: nativeAdapter,
                present: true,
                ownerIds: [],
                kind: 'credential',
              });
            final.integrations = (final.integrations ?? []).filter(
              (record) => record.agentId !== source.agentId,
            );
            final.integrations.push({
              agentId: source.agentId,
              configPath: source.path,
              entryHash: hashData(managedEntry(afterText, target!.format)),
              syncedRevision: final.revision,
              updatedAt: timestamp,
            });
          }
          final.activity.push({
            id: jobId,
            time: timestamp,
            operation: 'import_connectors',
            targetId: definitions[0]!.id,
            priorRevision: before.revision,
            newRevision: final.revision,
            result: 'succeeded',
          });
          final.activity = final.activity.slice(-200);
          StateSchema.parse(final);
          // Initializes/proves DPAPI before any source mutation; collision cannot
          // authorize overwriting an existing vault reference.
          for (const [id, value] of values) {
            assertSecretValue(value);
            effectSignal.throwIfAborted();
            if (await backend.has(id, effectSignal))
              throw new HubError(
                'conflict',
                'Generated import credential collision.',
              );
          }
          await safety.prepare({
            id: jobId,
            operation: 'import_connectors',
            targetId: source ? manifestId : definitions[0]!.id,
            expectedRevision: before.revision,
            beforeHash: stateHash(before),
            afterHash: stateHash(final),
            phase: 'prepared',
            reason: 'none',
            createdAt: timestamp,
            updatedAt: timestamp,
            external: true,
          });
          prepared = true;
          // Write the encrypted manifest first so interrupted imports remain
          // inspectable. Ordinary plaintext agent backup() is NEVER called.
          const ordered = source
            ? [
                [manifestId, values.get(manifestId)!] as const,
                ...[...values].filter(([id]) => id !== manifestId),
              ]
            : [...values];
          for (const [id, value] of ordered) {
            try {
              await backend.put(id, value, effectSignal);
            } catch {
              uncertainVault = true;
              throw new Error();
            }
            written.push(id);
            if (!(await backend.has(id, effectSignal))) throw new Error();
          }
          if (source && afterText !== null) {
            effectSignal.throwIfAborted();
            mutatedFile = true;
            await adapters!.files.replace(source.path, sourceText, afterText);
          }
          try {
            await store.write(before.revision, final);
          } catch {
            if (stateHash(await store.read()) !== stateHash(final))
              throw new Error();
          }
          committed = true;
          invalidate(definitions.map((definition) => definition.id));
          await safety.finish(jobId, 'committed').catch(() => undefined);
          return {
            state: 'imported' as const,
            revision: final.revision,
            connectorIds: definitions.map((definition) => definition.id),
            profileIds: input.profileIds,
            requiresApproval: true,
            authenticationVerified: false,
            agentConfigurationChanged: !!source,
            encryptedRecoveryIds: backupIds,
            processes: 0,
            networkRequests: 0,
          };
        } catch (error) {
          if (prepared && !committed) {
            let clean = !mutatedFile && !uncertainVault;
            try {
              if (stateHash(await store.read()) !== stateHash(before))
                clean = false;
            } catch {
              clean = false;
            }
            if (clean)
              for (const id of written.reverse())
                try {
                  await backend.delete(id, AbortSignal.timeout(10_000));
                  if (await backend.has(id, AbortSignal.timeout(10_000)))
                    clean = false;
                } catch {
                  clean = false;
                }
            await safety
              .finish(
                jobId,
                clean ? 'aborted' : 'needs_review',
                clean ? 'commit_failed' : 'state_drift',
              )
              .catch(() => undefined);
            throw new HubError(
              'unavailable',
              clean
                ? 'Import failed without changing the agent configuration. Create a fresh preview.'
                : 'Import interrupted. Encrypted recovery retained; inspect recovery before retrying. Plaintext credentials were not restored.',
            );
          }
          throw error;
        } finally {
          if (draft) clearImport(draft);
          for (const value of values.values()) value.fill(0);
          values.clear();
        }
      });
    },
    close() {
      imports.close();
      sources.clear();
    },
  };
}
