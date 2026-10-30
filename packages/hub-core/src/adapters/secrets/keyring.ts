import { timingSafeEqual } from 'node:crypto';
import {
  assertSecretId,
  assertSecretValue,
  type SecretBackend,
} from '../../auth/secrets.js';
import { HubError } from '../../errors.js';

export interface SecretCommand {
  executable: '/usr/bin/security' | '/usr/bin/secret-tool';
  arguments: readonly string[];
  stdin?: Buffer;
  signal: AbortSignal;
}
export interface SecretCommandResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  dispose(): void;
}
export type SecretCommandRunner = (
  command: SecretCommand,
) => Promise<SecretCommandResult>;
const unavailable = () =>
  new HubError(
    'unavailable',
    'The current-user system keyring is locked, denied or unavailable. No plaintext fallback was used.',
  );

// Account/attributes are runtime-scoped, generated identifiers only. Encoding
// preserves arbitrary UTF-8/newlines and cannot inject security's stdin grammar.
export function createKeyringSecretBackend({
  kind,
  scope,
  run,
  readOnly = false,
}: {
  kind: 'keychain' | 'libsecret';
  scope: string;
  run: SecretCommandRunner;
  readOnly?: boolean;
}): SecretBackend {
  if (!/^[a-f0-9-]{36}$/.test(scope)) throw unavailable();
  const account = (id: string) => {
    assertSecretId(id);
    return `${scope}/${id}`;
  };
  const attributes = (id: string) => [
    'application',
    'waleed-mcp-hub',
    'scope',
    scope,
    'id',
    id,
  ];
  async function lookup(
    id: string,
    signal: AbortSignal,
  ): Promise<Buffer | null> {
    const owner = account(id);
    signal.throwIfAborted();
    let result: SecretCommandResult | undefined;
    try {
      result = await run({
        executable:
          kind === 'keychain' ? '/usr/bin/security' : '/usr/bin/secret-tool',
        arguments:
          kind === 'keychain'
            ? ['find-generic-password', '-s', 'WaleedMcpHub', '-a', owner, '-w']
            : ['lookup', ...attributes(id)],
        signal,
      });
      signal.throwIfAborted();
      if (
        kind === 'keychain'
          ? result.exitCode === 44
          : result.exitCode === 1 &&
            result.stderr.length === 0 &&
            result.stdout.length === 0
      )
        return null;
      if (result.exitCode !== 0 || result.stdout.length > 12 * 1024)
        throw unavailable();
      const encoded = result.stdout.toString('utf8').replace(/\r?\n$/, '');
      if (!/^wmh-v1:[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw unavailable();
      const value = Buffer.from(encoded.slice(7), 'base64');
      try {
        assertSecretValue(value);
        if (`wmh-v1:${value.toString('base64')}` !== encoded)
          throw unavailable();
        return value;
      } catch {
        value.fill(0);
        throw unavailable();
      }
    } catch {
      throw unavailable();
    } finally {
      result?.dispose();
    }
  }
  return {
    async has(id, signal) {
      const value = await lookup(id, signal);
      try {
        return value !== null;
      } finally {
        value?.fill(0);
      }
    },
    async read(id, signal) {
      const value = await lookup(id, signal);
      if (!value) throw unavailable();
      return value;
    },
    async put(id, value, signal) {
      const owner = account(id);
      assertSecretValue(value);
      signal.throwIfAborted();
      if (readOnly) throw unavailable();
      const existing = await lookup(id, signal);
      if (existing) {
        existing.fill(0);
        throw new HubError(
          'conflict',
          'Secret identifiers are immutable; rotate to a new reference.',
        );
      }
      const encoded = `wmh-v1:${value.toString('base64')}`;
      const input = Buffer.from(
        kind === 'keychain'
          ? `add-generic-password -s WaleedMcpHub -a ${owner} -w ${encoded}\n`
          : encoded,
      );
      // Apple's interactive parser has a 4096-byte fixed line buffer. Never let
      // a long credential become a truncated item or a second parsed command.
      if (kind === 'keychain' && input.length > 4095) {
        input.fill(0);
        throw new HubError(
          'invalid',
          'Credential exceeds the supported Keychain stdin command limit.',
        );
      }
      let result: SecretCommandResult | undefined,
        verified: Buffer | null = null;
      try {
        result = await run({
          executable:
            kind === 'keychain' ? '/usr/bin/security' : '/usr/bin/secret-tool',
          arguments:
            kind === 'keychain'
              ? ['-q', '-i', '-p', '']
              : ['store', '--label=WaleedMcpHub', ...attributes(id)],
          stdin: input,
          signal,
        });
        if (result.exitCode !== 0) throw unavailable();
        signal.throwIfAborted();
        verified = await lookup(id, signal);
        if (
          !verified ||
          verified.length !== value.length ||
          !timingSafeEqual(verified, value)
        )
          throw unavailable();
      } catch {
        throw unavailable();
      } finally {
        input.fill(0);
        verified?.fill(0);
        result?.dispose();
      }
    },
    async delete(id, signal) {
      const owner = account(id);
      signal.throwIfAborted();
      if (readOnly) throw unavailable();
      const existing = await lookup(id, signal);
      if (!existing) return;
      existing.fill(0);
      let result: SecretCommandResult | undefined,
        remaining: Buffer | null = null;
      try {
        result = await run({
          executable:
            kind === 'keychain' ? '/usr/bin/security' : '/usr/bin/secret-tool',
          arguments:
            kind === 'keychain'
              ? ['delete-generic-password', '-s', 'WaleedMcpHub', '-a', owner]
              : ['clear', ...attributes(id)],
          signal,
        });
        if (result.exitCode !== 0) throw unavailable();
        signal.throwIfAborted();
        remaining = await lookup(id, signal);
        if (remaining) throw unavailable();
      } catch {
        throw unavailable();
      } finally {
        remaining?.fill(0);
        result?.dispose();
      }
    },
  };
}
