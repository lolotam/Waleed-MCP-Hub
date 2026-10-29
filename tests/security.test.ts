import { describe, expect, it } from 'vitest';
import { createSessions } from '../apps/server/src/security.js';

describe('launch and sessions', () => {
  it('accepts a token exactly once and binds CSRF to a session', () => {
    const sessions = createSessions();
    const token = sessions.issueLaunchToken();
    const session = sessions.consume(token)!;
    expect(session).not.toBeNull();
    expect(sessions.consume(token)).toBeNull();
    expect(sessions.verifyCsrf(session.id, session.csrf)).toBe(true);
    expect(sessions.verifyCsrf(session.id, 'é'.repeat(64))).toBe(false);
    expect(sessions.verifyCsrf('other', session.csrf)).toBe(false);
    sessions.revoke(session.id);
    expect(sessions.get(session.id)).toBeUndefined();
  });
  it('expires launches and sessions without timers', () => {
    let now = 0;
    const sessions = createSessions(() => now);
    const expired = sessions.issueLaunchToken();
    now += 120_001;
    expect(sessions.consume(expired)).toBeNull();
    const session = sessions.consume(sessions.issueLaunchToken())!;
    now += 8 * 60 * 60_000 + 1;
    expect(sessions.get(session.id)).toBeUndefined();
  });
  it('invalidates old launches and bounds repeated attempts', () => {
    const sessions = createSessions();
    const old = sessions.issueLaunchToken();
    const current = sessions.issueLaunchToken();
    expect(sessions.consume(old)).toBeNull();
    for (let i = 0; i < 20; i++) sessions.consume('bad');
    expect(sessions.consume(current)).toBeNull();
  });
});
