import { z } from 'zod';

// Syntax only. The transport separately resolves, checks and pins every address.
// Require the literal authority and an explicit port; URL normalization must not
// turn integer/hex/shortened IP aliases into consent to a different destination.
export function isLocalHttpEndpoint(value: string): boolean {
  const match =
    /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})(?:\/[^\s\\]*)?$/i.exec(
      value,
    );
  if (!match || Number(match[2]) > 65535) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      !/[?#]/.test(value) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export const EndpointSchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        value !== value.trim() ||
        /[\0-\x20\x7f\\?#]/.test(value) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol === 'https:'
          ? !/^https:\/\//i.test(value)
          : !isLocalHttpEndpoint(value))
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Use HTTPS or explicit-port loopback HTTP, without credentials, query strings or fragments.',
        });
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid endpoint.' });
    }
  });
