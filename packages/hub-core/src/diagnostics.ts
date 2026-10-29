import { HubError } from './errors.js';

const messages = {
  conflict:
    'The operation conflicts with current state. Refresh inventory and review recovery before previewing again.',
  unavailable:
    'Local storage or a required capability is unavailable. Inspect the runtime and retry safely.',
  invalid:
    'The input or operation is unsupported. Check its format and limits.',
  not_found:
    'The item is missing, expired, or belongs to another session. Refresh and preview again.',
  busy: 'The runtime is locked or another operation is in progress. Do not remove locks until their owner has stopped.',
} as const;

// Exceptions are not a public diagnostic contract. Never echo error.message,
// stack, request bodies, or subprocess output, even for a HubError.
export function publicError(error: unknown): {
  code: keyof typeof messages | 'internal_error';
  message: string;
} {
  if (error instanceof HubError && Object.hasOwn(messages, error.code))
    return { code: error.code, message: messages[error.code] };
  return {
    code: 'internal_error',
    message:
      'The operation failed. Inspect the local registry and recovery status before retrying.',
  };
}

// Defense in depth for future provider diagnostics, NOT permission to log raw
// imports, stdin, arguments, HTTP bodies, or unregistered credentials. Audit and
// journal persistence accept closed metadata schemas instead of arbitrary text.
export function redactDiagnostic(
  input: string,
  knownSecrets: readonly string[] = [],
): string {
  if (
    typeof input !== 'string' ||
    input.length > 16 * 1024 ||
    knownSecrets.length > 64
  )
    return '[diagnostic omitted]';
  if (knownSecrets.some((secret) => secret.length < 8 || secret.length > 8192))
    return '';
  const masks = new Set<string>();
  for (const secret of knownSecrets) {
    for (const value of [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
      Buffer.from(secret).toString('base64'),
    ]) {
      masks.add(value);
      if (value.length >= 24) {
        masks.add(value.slice(0, 12));
        masks.add(value.slice(-12));
      }
    }
  }
  let text = input;
  for (const value of [...masks].sort((a, b) => b.length - a.length))
    text = text.split(value).join('[hidden]');
  text = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[private key hidden]',
  );
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      return new URL(value).origin + '/[details hidden]';
    } catch {
      return '[URL hidden]';
    }
  });
  text = text.replace(/\b(Bearer|Basic)\s+[a-z0-9+/_=.:-]+/gi, '$1 [hidden]');
  text = text.replace(
    /("[^"\r\n]*(?:token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)[^"\r\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[hidden]"',
  );
  text = text.replace(
    /\b([a-z0-9_-]*(?:token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)[a-z0-9_-]*\s*[:=]\s*)[^\r\n]+/gi,
    '$1[hidden]',
  );
  text = [...text]
    .filter(
      (character) =>
        character.charCodeAt(0) >= 32 ||
        character === '\n' ||
        character === '\t',
    )
    .join('');
  if ([...masks].some((value) => text.includes(value))) return '';
  return text.length > 8192 ? '[diagnostic omitted]' : text;
}
