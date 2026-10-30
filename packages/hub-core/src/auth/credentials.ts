import { randomUUID } from 'node:crypto';
import {
  CredentialWriteSchema,
  StateSchema,
  type Connector,
  type CredentialWrite,
} from '@waleed/contracts';
import type { StateStore } from '../state.js';
import type { SafetyLedger } from '../safety.js';
import { stateHash } from '../safety.js';
import { HubError } from '../errors.js';
import {
  approved,
  definitionHash,
  requireConnector,
} from '../runtime/registry.js';
import { assertBinding } from './bindings.js';
import {
  assertSecretId,
  assertSecretValue,
  nativeSecretAdapter,
  type SecretBackends,
} from './secrets.js';

export type MutationLock = <T>(action: () => Promise<T>) => Promise<T>;
export function createCredentials(
  store: StateStore,
  safety: SafetyLedger,
  backends: SecretBackends,
  lock: MutationLock,
  invalidate: (ids: string[]) => void,
  now: () => number = Date.now,
) {
  const timestamp = () => new Date(now()).toISOString();
  return {
    enabled: Object.values(backends).some(Boolean),
    nativeAdapter: () => nativeSecretAdapter(backends),
    backends,
    async write(connectorId: string, raw: unknown) {
      let value: Buffer | undefined;
      try {
        const input = CredentialWriteSchema.parse(raw);
        value = Buffer.from(input.value, 'utf8');
        input.value = '';
        if (raw && typeof raw === 'object' && 'value' in raw)
          (raw as { value: unknown }).value = '';
        return await this.commit(connectorId, input, value);
      } finally {
        value?.fill(0);
        if (raw && typeof raw === 'object' && 'value' in raw)
          (raw as { value: unknown }).value = '';
      }
    },
    async commit(
      connectorId: string,
      input: Omit<CredentialWrite, 'value'>,
      value: Buffer,
      oauth?: { recipeId: string; carryApproval: true },
    ) {
      try {
        assertSecretValue(value);
        assertBinding(input.location, input.name, input.format);
        if (
          input.location === 'header' &&
          /[\r\n]/.test(value.toString('utf8'))
        )
          throw new HubError('invalid', 'Headers cannot contain line breaks.');
        const backend = backends[input.adapter];
        if (!backend)
          throw new HubError(
            'unavailable',
            'Credential backend is not configured.',
          );
        return await lock(async () => {
          await safety.assertWritable();
          const before = await store.read();
          const current = requireConnector(before, connectorId);
          if (
            before.revision !== input.expectedRevision ||
            current.revision !== input.expectedConnectorRevision
          )
            throw new HubError('conflict', 'Credential editor is stale.');
          const privateText = value.toString('utf8');
          if (
            privateText === input.name ||
            (privateText.length >= 4 &&
              [
                privateText,
                encodeURIComponent(privateText),
                Buffer.from(privateText).toString('base64'),
              ].some((variant) =>
                JSON.stringify({
                  connector: current,
                  name: input.name,
                }).includes(variant),
              ))
          )
            throw new HubError(
              'invalid',
              'Credential values cannot appear in public binding names or definitions.',
            );
          if (
            current.executionMode === 'remote'
              ? input.location !== 'header' ||
                input.adapter !== nativeSecretAdapter(backends)
              : input.location !== 'environment' ||
                input.adapter !==
                  (current.executionMode === 'docker'
                    ? 'docker'
                    : nativeSecretAdapter(backends))
          )
            throw new HubError(
              'invalid',
              'Credential backend/binding does not match the connector runtime.',
            );
          if (
            oauth &&
            (!approved(current) || current.executionMode !== 'remote')
          )
            throw new HubError(
              'conflict',
              'OAuth discovery requires current execution approval.',
            );
          const next = structuredClone(before);
          const connector = requireConnector(next, connectorId);
          const previousOAuthId = oauth
            ? connector.headerBindings.Authorization
            : undefined;
          const id = `wmh-secret-${randomUUID()}`;
          const bindings =
            input.location === 'header'
              ? connector.headerBindings
              : connector.secretBindings;
          // Case-insensitive headers/environment cannot shadow an existing binding.
          for (const name of Object.keys(bindings))
            if (name.toLowerCase() === input.name.toLowerCase())
              delete bindings[name];
          bindings[input.name] = id;
          if (input.location === 'header')
            connector.credentialFormats = {
              ...connector.credentialFormats,
              [input.name]: input.format,
            };
          connector.revision++;
          connector.updatedAt = timestamp();
          connector.trustApproval = null;
          if (oauth)
            connector.trustApproval = {
              revision: connector.revision,
              definitionHash: definitionHash(connector),
              risk: 'network',
              approvedAt: timestamp(),
            };
          for (const reference of next.secretReferences)
            reference.ownerIds = next.connectors
              .filter((item) =>
                [
                  ...Object.values(item.headerBindings),
                  ...Object.values(item.secretBindings),
                ].includes(reference.id),
              )
              .map((item) => item.id)
              .concat(
                reference.ownerIds.filter(
                  (owner) =>
                    !before.connectors.some((item) => item.id === owner),
                ),
              );
          next.secretReferences.push({
            id,
            adapter: input.adapter,
            present: true,
            ownerIds: [connectorId],
            kind: oauth ? 'oauth' : 'credential',
            ...(oauth ? { recipeId: oauth.recipeId } : {}),
          });
          const retiredOAuth =
            previousOAuthId &&
            next.secretReferences.find(
              (ref) =>
                ref.id === previousOAuthId &&
                ref.kind === 'oauth' &&
                !ref.ownerIds.length &&
                !next.materializations?.some((record) =>
                  record.secretReferenceIds?.includes(ref.id),
                ),
            );
          if (retiredOAuth)
            next.secretReferences = next.secretReferences.filter(
              (ref) => ref.id !== retiredOAuth.id,
            );
          if (next.secretReferences.length > 256)
            throw new HubError(
              'invalid',
              'Credential reference capacity reached. Remove unused local references first.',
            );
          for (const profile of next.profiles)
            if (profile.connectorIds.includes(connectorId)) {
              profile.revision++;
              profile.updatedAt = timestamp();
              for (const binding of next.agentBindings ?? [])
                if (binding.profileId === profile.id)
                  binding.reconnectRequired = true;
            }
          next.revision++;
          const jobId = randomUUID();
          next.activity.push({
            id: jobId,
            time: timestamp(),
            operation: 'write_credential',
            targetId: connectorId,
            priorRevision: before.revision,
            newRevision: next.revision,
            result: 'succeeded',
          });
          next.activity = next.activity.slice(-200);
          StateSchema.parse(next);
          const beforeHash = stateHash(before),
            afterHash = stateHash(next);
          // Fail an unavailable backend before preparing any external effect.
          // A collision is never permission to overwrite another stored value.
          if (await backend.has(id, AbortSignal.timeout(10_000)))
            throw new HubError(
              'conflict',
              'Generated credential identifier collision.',
            );
          await safety.prepare({
            id: jobId,
            operation: 'write_credential',
            targetId: id,
            expectedRevision: before.revision,
            beforeHash,
            afterHash,
            phase: 'prepared',
            reason: 'none',
            createdAt: timestamp(),
            updatedAt: timestamp(),
            external: true,
          });
          let written = false;
          try {
            await backend.put(id, value, AbortSignal.timeout(30_000));
            written = true;
            if (!(await backend.has(id, AbortSignal.timeout(10_000))))
              throw new HubError(
                'unavailable',
                'Secret presence read-back failed.',
              );
            await store.write(before.revision, next);
            invalidate([connectorId]);
          } catch {
            const actual = stateHash(await store.read());
            if (actual === afterHash) {
              invalidate([
                connectorId,
              ]); /* Post-commit error: exact read-back, never duplicate. */
            } else {
              let restored = false;
              if (written && actual === beforeHash) {
                try {
                  await backend.delete(id, AbortSignal.timeout(20_000));
                  restored = !(await backend.has(
                    id,
                    AbortSignal.timeout(10_000),
                  ));
                } catch {
                  /* Unknown external result stays blocking. */
                }
              }
              await safety
                .finish(
                  jobId,
                  restored ? 'aborted' : 'needs_review',
                  restored ? 'commit_failed' : 'state_drift',
                )
                .catch(() => undefined);
              throw new HubError(
                'unavailable',
                'Credential save failed. Review recovery before retrying.',
              );
            }
          }
          if (retiredOAuth) {
            try {
              await backend.delete(
                retiredOAuth.id,
                AbortSignal.timeout(20_000),
              );
              if (
                await backend.has(retiredOAuth.id, AbortSignal.timeout(10_000))
              )
                throw new Error();
            } catch {
              await safety
                .finish(jobId, 'needs_review', 'state_drift')
                .catch(() => undefined);
              throw new HubError(
                'unavailable',
                'Retired OAuth token cleanup needs recovery review.',
              );
            }
          }
          await safety.finish(jobId, 'committed').catch(() => undefined);
          return {
            id,
            present: true as const,
            connectorId,
            revision: connector.revision,
            requiresApproval: !oauth,
          };
        });
      } finally {
        value.fill(0);
      }
    },
    async delete(id: string, expectedRevision: number) {
      assertSecretId(id);
      return lock(async () => {
        await safety.assertWritable();
        const before = await store.read();
        const reference = before.secretReferences.find(
          (item) => item.id === id,
        );
        if (before.revision !== expectedRevision)
          throw new HubError('conflict', 'Credential inventory changed.');
        if (!reference)
          throw new HubError('not_found', 'Credential reference not found.');
        if (
          reference.ownerIds.length ||
          before.connectors.some((item) =>
            [
              ...Object.values(item.headerBindings),
              ...Object.values(item.secretBindings),
            ].includes(id),
          ) ||
          before.materializations?.some((record) =>
            record.secretReferenceIds?.includes(id),
          )
        )
          throw new HubError(
            'conflict',
            'Unassign all credential consumers and dematerialize old snapshots before local deletion.',
          );
        const backend = backends[reference.adapter];
        if (!backend)
          throw new HubError('unavailable', 'Credential backend unavailable.');
        const next = structuredClone(before);
        next.secretReferences = next.secretReferences.filter(
          (item) => item.id !== id,
        );
        next.revision++;
        const jobId = randomUUID();
        await safety.prepare({
          id: jobId,
          operation: 'delete_credential',
          targetId: id,
          expectedRevision: before.revision,
          beforeHash: stateHash(before),
          afterHash: stateHash(next),
          phase: 'prepared',
          reason: 'none',
          createdAt: timestamp(),
          updatedAt: timestamp(),
          external: true,
        });
        try {
          await backend.delete(id, AbortSignal.timeout(20_000));
          if (await backend.has(id, AbortSignal.timeout(10_000)))
            throw new Error();
          await store.write(before.revision, next);
        } catch {
          if (stateHash(await store.read()) !== stateHash(next)) {
            await safety
              .finish(jobId, 'needs_review', 'state_drift')
              .catch(() => undefined);
            throw new HubError(
              'unavailable',
              'Deletion needs recovery review; provider authorization was not revoked.',
            );
          }
        }
        await safety.finish(jobId, 'committed').catch(() => undefined);
        return { id, present: false as const, providerRevoked: false as const };
      });
    },
    async disconnectOAuth(
      connectorId: string,
      expectedRevision: number,
      expectedConnectorRevision: number,
    ) {
      return lock(async () => {
        await safety.assertWritable();
        const before = await store.read(),
          current = requireConnector(before, connectorId);
        if (
          before.revision !== expectedRevision ||
          current.revision !== expectedConnectorRevision
        )
          throw new HubError('conflict', 'Account inventory changed.');
        const id = current.headerBindings.Authorization;
        if (!id) throw new HubError('not_found', 'OAuth account not found.');
        const reference = before.secretReferences.find(
          (ref) =>
            ref.id === id && ref.kind === 'oauth' && ref.adapter === 'windows',
        );
        if (!reference || !backends.windows)
          throw new HubError('not_found', 'OAuth account not found.');
        if (
          reference.ownerIds.some((owner) => owner !== connectorId) ||
          before.connectors.some(
            (item) =>
              item.id !== connectorId &&
              [
                ...Object.values(item.headerBindings),
                ...Object.values(item.secretBindings),
              ].includes(id),
          ) ||
          before.materializations?.some((item) =>
            item.secretReferenceIds?.includes(id),
          )
        )
          throw new HubError(
            'conflict',
            'Remove other credential consumers before disconnecting.',
          );
        const next = structuredClone(before),
          connector = requireConnector(next, connectorId);
        delete connector.headerBindings.Authorization;
        if (connector.credentialFormats)
          delete connector.credentialFormats.Authorization;
        connector.revision++;
        connector.updatedAt = timestamp();
        connector.trustApproval = null;
        next.secretReferences = next.secretReferences.filter(
          (ref) => ref.id !== id,
        );
        for (const profile of next.profiles)
          if (profile.connectorIds.includes(connectorId)) {
            profile.revision++;
            profile.updatedAt = timestamp();
            for (const binding of next.agentBindings ?? [])
              if (binding.profileId === profile.id)
                binding.reconnectRequired = true;
          }
        next.revision++;
        StateSchema.parse(next);
        const jobId = randomUUID();
        await safety.prepare({
          id: jobId,
          operation: 'delete_credential',
          targetId: id,
          expectedRevision: before.revision,
          beforeHash: stateHash(before),
          afterHash: stateHash(next),
          phase: 'prepared',
          reason: 'none',
          createdAt: timestamp(),
          updatedAt: timestamp(),
          external: true,
        });
        try {
          // First detach/unapprove so a concurrent bridge cannot lease it again.
          await store.write(before.revision, next);
          invalidate([connectorId]);
          await backends.windows.delete(id, AbortSignal.timeout(20_000));
          if (await backends.windows.has(id, AbortSignal.timeout(10_000)))
            throw new Error();
        } catch {
          await safety
            .finish(jobId, 'needs_review', 'state_drift')
            .catch(() => undefined);
          throw new HubError(
            'unavailable',
            'Account disconnect needs recovery review.',
          );
        }
        await safety.finish(jobId, 'committed').catch(() => undefined);
        return { connectorId, disconnected: true as const };
      });
    },
  };
}
export type Credentials = ReturnType<typeof createCredentials>;
export function sameDefinition(
  connector: Connector,
  revision: number,
  hash: string,
) {
  return (
    connector.revision === revision &&
    definitionHash(connector) === hash &&
    approved(connector) &&
    connector.enabled
  );
}
