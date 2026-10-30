import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import {
  ClientTokenSchema,
  ClientTokensListSchema,
  ClientTokenSecretSchema,
  CreateClientTokenRequestSchema,
  RevokeClientTokenRequestSchema,
  type ClientToken,
} from '@waleed/contracts';
import type { MutationLock } from '../auth/credentials.js';
import type { StateStore } from '../state.js';
import { HubError } from '../errors.js';

export const StoredClientTokensSchema = z
  .strictObject({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tokens: z
      .array(
        z.strictObject({
          metadata: ClientTokenSchema,
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(256),
  })
  .refine(
    (value) =>
      new Set(value.tokens.map((token) => token.metadata.id)).size ===
      value.tokens.length,
  );
export type StoredClientTokens = z.infer<typeof StoredClientTokensSchema>;
export interface ClientTokenStore {
  read(): Promise<StoredClientTokens>;
  write(expectedRevision: number, next: StoredClientTokens): Promise<void>;
}
export function memoryClientTokenStore(): ClientTokenStore {
  let value: StoredClientTokens = { revision: 0, tokens: [] };
  return {
    async read() {
      return structuredClone(value);
    },
    async write(expected, next) {
      if (expected !== value.revision)
        throw new HubError('conflict', 'Client tokens changed.');
      value = StoredClientTokensSchema.parse(structuredClone(next));
    },
  };
}
const digest = (value: string) => createHash('sha256').update(value).digest();
export function createClientTokens({
  store,
  registry,
  mutation,
  assertWritable,
  now = Date.now,
}: {
  store: ClientTokenStore;
  registry: StateStore;
  mutation: MutationLock;
  assertWritable: () => Promise<void>;
  now?: () => number;
}) {
  const denied = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  let closed = false;
  const active = (metadata: ClientToken) =>
    !closed &&
    !denied.has(metadata.id) &&
    !metadata.revokedAt &&
    (!metadata.expiresAt || Date.parse(metadata.expiresAt) > now());
  const read = async () => {
    if (closed) throw new HubError('unavailable', 'Client tokens unavailable.');
    try {
      return StoredClientTokensSchema.parse(await store.read());
    } catch {
      throw new HubError('unavailable', 'Client token storage is unavailable.');
    }
  };
  const list = async () => {
    const value = await read();
    return ClientTokensListSchema.parse({
      revision: value.revision,
      tokens: value.tokens.map((item) => item.metadata),
    });
  };
  const invalidate = (id: string) => {
    denied.add(id);
    for (const listener of listeners) listener(id);
  };
  return {
    list,
    create(raw: unknown) {
      return mutation(async () => {
        const input = CreateClientTokenRequestSchema.parse(raw);
        await assertWritable();
        const value = await read();
        if (input.expectedRevision !== value.revision)
          throw new HubError(
            'conflict',
            'Client tokens changed. Refresh before retrying.',
          );
        if (value.tokens.length >= 256)
          throw new HubError('conflict', 'Client token capacity reached.');
        if (input.expiresAt && Date.parse(input.expiresAt) <= now())
          throw new HubError('invalid', 'Token expiry must be in the future.');
        if (
          input.profileId &&
          !(await registry.read()).profiles.some(
            (profile) =>
              profile.id === input.profileId && profile.enabled !== false,
          )
        )
          throw new HubError('invalid', 'Choose an enabled profile.');
        const entropy = randomBytes(32);
        const plaintextToken = `wmh_live_${entropy.toString('hex')}`;
        entropy.fill(0);
        const metadata = ClientTokenSchema.parse({
          id: randomUUID(),
          label: input.label,
          agentId: input.agentId ?? 'http-client',
          profileId: input.profileId,
          tokenPreview: `wmh_live_...${plaintextToken.slice(-4)}`,
          createdAt: new Date(now()).toISOString(),
          expiresAt: input.expiresAt,
        });
        const next = {
          revision: value.revision + 1,
          tokens: [
            ...value.tokens,
            { metadata, hash: digest(plaintextToken).toString('hex') },
          ],
        };
        await store.write(value.revision, next);
        return { revision: next.revision, token: metadata, plaintextToken };
      });
    },
    revoke(id: string, raw: unknown) {
      return mutation(async () => {
        const input = RevokeClientTokenRequestSchema.parse(raw);
        // Revocation must remain possible even while recovery blocks new credentials.
        const value = await read();
        if (input.expectedRevision !== value.revision)
          throw new HubError(
            'conflict',
            'Client tokens changed. Refresh before retrying.',
          );
        const entry = value.tokens.find((token) => token.metadata.id === id);
        if (!entry) throw new HubError('not_found', 'Client token not found.');
        invalidate(id); // Fail closed even if persistence subsequently fails.
        if (!entry.metadata.revokedAt) {
          entry.metadata.revokedAt = new Date(now()).toISOString();
          await store.write(value.revision, {
            revision: value.revision + 1,
            tokens: value.tokens,
          });
        }
        return list();
      });
    },
    async authenticate(secret: unknown): Promise<ClientToken | undefined> {
      if (closed || !ClientTokenSecretSchema.safeParse(secret).success)
        return undefined;
      const candidate = digest(secret as string);
      let result: ClientToken | undefined;
      // Compare every fixed-length hash, with no early exit for a matching token.
      try {
        for (const entry of (await read()).tokens) {
          const equal = timingSafeEqual(
            candidate,
            Buffer.from(entry.hash, 'hex'),
          );
          if (equal && active(entry.metadata)) result = entry.metadata;
        }
      } finally {
        candidate.fill(0);
      }
      return result;
    },
    async requireActive(id: string) {
      const metadata = (await read()).tokens.find(
        (entry) => entry.metadata.id === id,
      )?.metadata;
      if (!metadata || !active(metadata))
        throw new HubError('unavailable', 'Client token is inactive.');
      return metadata;
    },
    onInvalidate(listener: (id: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      for (const listener of listeners) listener('*');
      listeners.clear();
    },
  };
}
export type ClientTokens = ReturnType<typeof createClientTokens>;
