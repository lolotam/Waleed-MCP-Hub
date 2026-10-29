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
  isPackageEnvName,
  requireConnector,
} from '../runtime/registry.js';
import { assertBinding } from './bindings.js';
import {
  assertSecretId,
  assertSecretValue,
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
    enabled: !!backends.windows || !!backends.docker,
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
              ? input.location !== 'header' || input.adapter !== 'windows'
              : input.location !== 'environment' ||
                input.adapter !==
                  (current.executionMode === 'docker' ? 'docker' : 'windows')
          )
            throw new HubError(
              'invalid',
              'Credential backend/binding does not match the connector runtime.',
            );
          // A managed package may never receive a NODE_ environment variable:
          // nothing outside the install can preload code or change TLS trust.
          if (
            current.executionMode === 'native' &&
            current.package &&
            input.location === 'environment' &&
            isPackageEnvName(input.name)
          )
            throw new HubError(
              'invalid',
              'Environment names starting with NODE_ are refused on package connectors.',
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
