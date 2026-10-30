import { randomUUID } from 'node:crypto';
import {
  McpbInstallSchema,
  ConnectorSchema,
  StateSchema,
  type McpbPreview,
} from '@waleed/contracts';
import type { StateStore } from '../state.js';
import { stateHash, type SafetyLedger } from '../safety.js';
import type { MutationLock } from '../auth/credentials.js';
import { assertSecretValue, type SecretBackends } from '../auth/secrets.js';
import { HubError } from '../errors.js';
import { assertNoCredentialEcho } from './bridge.js';
import { hashBytes } from '../runtime/registry.js';
import {
  inspectMcpb,
  clearMcpb,
  resolveMcpbConfiguration,
  McpbExtractionFault,
  type InspectedMcpb,
  type McpbAdapter,
} from '../adapters/mcpb.js';

export function createMcpbService(
  store: StateStore,
  safety: SafetyLedger,
  lock: MutationLock,
  backends: SecretBackends,
  adapter: McpbAdapter | undefined,
  now = Date.now,
) {
  const drafts = new Map<
    string,
    { owner: string; expires: number; bundle: InspectedMcpb }
  >();
  let closed = false;
  const drop = (id: string) => {
    const entry = drafts.get(id);
    if (entry) clearMcpb(entry.bundle);
    drafts.delete(id);
  };
  const prune = () => {
    for (const [id, entry] of drafts) if (entry.expires <= now()) drop(id);
  };
  const timer = setInterval(prune, 30_000);
  timer.unref();
  const get = (id: string, owner: string) => {
    prune();
    const entry = drafts.get(id);
    if (closed || !entry || entry.owner !== owner)
      throw new HubError('not_found', 'Bundle preview is missing or expired.');
    return entry;
  };
  return {
    preview(archive: Buffer, owner: string): McpbPreview {
      try {
        if (closed || !adapter)
          throw new HubError(
            'unavailable',
            'Bundle installation is unavailable.',
          );
        prune();
        if (drafts.size >= 2)
          throw new HubError(
            'busy',
            'Discard another bundle preview before uploading.',
          );
        const bundle = inspectMcpb(archive),
          id = randomUUID(),
          expires = now() + 5 * 60_000;
        drafts.set(id, { owner, expires, bundle });
        return {
          id,
          manifest: structuredClone(bundle.manifest),
          archiveHash: bundle.archiveHash,
          fileCount: bundle.files.size,
          uncompressedBytes: bundle.uncompressedBytes,
          expiresAt: new Date(expires).toISOString(),
        };
      } finally {
        archive.fill(0);
      }
    },
    cancel(id: string, owner: string) {
      get(id, owner);
      drop(id);
      return { discarded: true };
    },
    revoke(owner: string) {
      for (const [id, entry] of drafts) if (entry.owner === owner) drop(id);
    },
    async install(id: string, raw: unknown, owner: string) {
      let input: ReturnType<typeof McpbInstallSchema.parse> | undefined;
      let ownedBundle: InspectedMcpb | undefined;
      let environment: Record<string, Buffer> = {};
      try {
        input = McpbInstallSchema.parse(raw);
        const { bundle } = get(id, owner);
        ownedBundle = bundle;
        drafts.delete(id);
        if (!adapter)
          throw new HubError(
            'unavailable',
            'Bundle installation is unavailable.',
          );
        // Lock before reading the registry or performing any external write.
        return await lock(async () => {
          await safety.assertWritable();
          const state = await store.read();
          if (state.revision !== input!.expectedRevision)
            throw new HubError(
              'conflict',
              'Inventory changed. Review the bundle again.',
            );
          if (state.connectors.length >= 256)
            throw new HubError('invalid', 'Connector limit reached.');
          const bundleId = randomUUID(),
            connectorId = `bundle-${bundleId}`,
            operationId = randomUUID();
          const executable = await adapter.executable(
            bundle.manifest,
            bundleId,
          );
          const resolved = resolveMcpbConfiguration(
            bundle,
            adapter.path(bundleId),
            input!.configuration,
          );
          environment = resolved.environment;
          for (const bytes of Object.values(environment))
            assertSecretValue(bytes);
          if (Object.keys(environment).length && !backends.windows?.read)
            throw new HubError(
              'unavailable',
              'DPAPI credential protection is required for bundle environment configuration.',
            );
          const next = structuredClone(state),
            timestamp = new Date(now()).toISOString(),
            secretBindings: Record<string, string> = {};
          const writes: Array<{ id: string; bytes: Buffer }> = [];
          for (const [name, bytes] of Object.entries(environment)) {
            const secretId = `wmh-secret-${randomUUID()}`;
            secretBindings[name] = secretId;
            writes.push({ id: secretId, bytes });
            next.secretReferences.push({
              id: secretId,
              adapter: 'windows',
              present: true,
              ownerIds: [connectorId],
              kind: 'credential',
            });
          }
          const receipt = {
            id: bundleId,
            archiveHash: bundle.archiveHash,
            files: [...bundle.files].map(([path, bytes]) => ({
              path,
              size: bytes.length,
              sha256: hashBytes(bytes),
            })),
          };
          const connector = ConnectorSchema.parse({
            id: connectorId,
            name: bundle.manifest.name,
            description: bundle.manifest.description,
            enabled: true,
            revision: 1,
            secretBindings,
            headerBindings: {},
            environmentLiterals: {},
            trustApproval: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            executionMode: 'native',
            transport: 'stdio',
            executable,
            arguments: resolved.arguments,
            bundle: receipt,
          });
          try {
            assertNoCredentialEcho(
              { connector, manifest: bundle.manifest },
              Object.entries(
                bundle.manifest.user_config ??
                  bundle.manifest.configuration ??
                  {},
              )
                .filter(([, field]) => field.secret || field.sensitive)
                .map(([key]) => String(input!.configuration[key] ?? ''))
                .filter(Boolean),
            );
          } catch {
            throw new HubError(
              'invalid',
              'Protected configuration cannot appear in public bundle metadata or arguments.',
            );
          }
          next.connectors.push(connector);
          next.revision++;
          next.activity.push({
            id: operationId,
            time: timestamp,
            operation: 'import_connectors',
            targetId: connectorId,
            priorRevision: state.revision,
            newRevision: next.revision,
            result: 'succeeded',
          });
          next.activity = next.activity.slice(-200);
          const checked = StateSchema.parse(next),
            beforeHash = stateHash(state),
            afterHash = stateHash(checked);
          await safety.prepare({
            id: operationId,
            operation: 'import_connectors',
            targetId: connectorId,
            expectedRevision: state.revision,
            beforeHash,
            afterHash,
            phase: 'prepared',
            reason: 'none',
            createdAt: timestamp,
            updatedAt: timestamp,
            external: true,
          });
          const attempted: string[] = [];
          let extracted = false;
          try {
            // An uncertain DPAPI write is still tracked and removed on proved rollback.
            for (const write of writes) {
              attempted.push(write.id);
              await backends.windows!.put(
                write.id,
                write.bytes,
                AbortSignal.timeout(15_000),
              );
            }
            await adapter.extract(bundle, bundleId);
            extracted = true;
            await store.write(state.revision, checked);
          } catch (error) {
            try {
              const actual = stateHash(await store.read());
              if (actual === afterHash) {
                await safety.finish(operationId, 'committed');
                return {
                  connectorId,
                  state: 'saved' as const,
                  requiresApproval: true,
                };
              }
              if (actual !== beforeHash) throw error;
              if (error instanceof McpbExtractionFault && !error.restored)
                throw error;
              if (extracted) await adapter.remove(bundleId);
              for (const secretId of attempted)
                await backends.windows!.delete(
                  secretId,
                  AbortSignal.timeout(15_000),
                );
              await safety.finish(operationId, 'aborted', 'commit_failed');
            } catch {
              await safety
                .finish(operationId, 'needs_review', 'state_drift')
                .catch(() => undefined);
              throw new HubError(
                'unavailable',
                'Bundle installation needs recovery review. Do not retry installation.',
              );
            }
            throw error instanceof HubError
              ? error
              : new HubError(
                  'unavailable',
                  'Bundle installation failed and was rolled back.',
                );
          }
          let recoveryRequired = false;
          try {
            await safety.finish(operationId, 'committed');
          } catch {
            recoveryRequired = true;
          }
          return {
            connectorId,
            state: 'saved' as const,
            requiresApproval: true,
            recoveryRequired,
          };
        });
      } finally {
        for (const bytes of Object.values(environment)) bytes.fill(0);
        for (const source of [raw, input])
          if (
            source &&
            typeof source === 'object' &&
            'configuration' in source
          ) {
            const configuration = source.configuration;
            if (configuration && typeof configuration === 'object')
              for (const key of Object.keys(configuration))
                (configuration as Record<string, unknown>)[key] = '';
          }
        if (drafts.get(id)?.owner === owner) drop(id);
        if (ownedBundle) clearMcpb(ownedBundle);
      }
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const id of drafts.keys()) drop(id);
    },
  };
}
