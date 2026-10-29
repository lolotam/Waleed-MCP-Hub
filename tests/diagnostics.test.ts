import { describe, expect, it } from 'vitest';
import { HubError, publicError, redactDiagnostic } from '@waleed/hub-core';

describe('secret-safe diagnostic boundaries', () => {
  const secret = [
    'SYNTHETIC',
    'credential / with "quotes" and Unicode أهلا',
  ].join('-');
  it('masks known values, encoded variants, and common prefix/suffix fragments', () => {
    const encoded = encodeURIComponent(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    const base64 = Buffer.from(secret).toString('base64');
    const output = redactDiagnostic(
      [
        secret,
        encoded,
        escaped,
        base64,
        secret.slice(0, 12),
        secret.slice(-12),
      ].join('\n'),
      [secret],
    );
    for (const value of [
      secret,
      encoded,
      escaped,
      base64,
      secret.slice(0, 12),
      secret.slice(-12),
    ])
      expect(output).not.toContain(value);
    expect(output).toContain('[hidden]');
  });
  it('masks credential fields, authorization headers, and all URL path/query details', () => {
    const output = redactDiagnostic(
      [
        'Authorization: Bearer synthetic-value',
        'X-Api-Key=another-value',
        JSON.stringify({
          clientSecret: 'json-value',
          PASSWORD: 'escaped"value',
        }),
        'https://user:pass@example.test/private-token?access=unknown-value',
      ].join('\n'),
    );
    for (const value of [
      'synthetic-value',
      'another-value',
      'json-value',
      'escaped',
      'user:pass',
      'private-token',
      'unknown-value',
    ])
      expect(output).not.toContain(value);
    expect(output).toContain('https://example.test/');
  });
  it('omits truncated private-key blocks and oversized input rather than leaking truncated secrets', () => {
    const input = ['-----BEGIN', 'PRIVATE KEY-----\nSYNTHETIC-KEY-BODY'].join(
      ' ',
    );
    expect(redactDiagnostic(input)).not.toContain('SYNTHETIC-KEY-BODY');
    expect(redactDiagnostic('x'.repeat(16 * 1024 + 1))).toBe(
      '[diagnostic omitted]',
    );
    expect(redactDiagnostic('a', ['a'])).toBe('');
  });
  it('removes terminal control characters and leaves ordinary corrective text readable', () => {
    expect(redactDiagnostic('Check Docker readiness.')).toBe(
      'Check Docker readiness.',
    );
    expect(
      redactDiagnostic(String.fromCharCode(27) + '[31mtext'),
    ).not.toContain(String.fromCharCode(27));
  });
  it('never treats exception messages/stacks as public diagnostics, including HubError messages', () => {
    for (const error of [
      new Error(secret),
      new HubError('conflict', secret),
      { message: secret },
      secret,
    ]) {
      expect(JSON.stringify(publicError(error))).not.toContain(secret);
    }
    expect(publicError(new HubError('conflict', secret)).code).toBe('conflict');
  });
});
