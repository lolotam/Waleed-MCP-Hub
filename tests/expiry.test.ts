import { describe, expect, it } from 'vitest';
import { MAX_TIMER_DELAY_MS, expiryDelay } from '../apps/web/src/expiry';

const now = Date.parse('2026-11-23T00:00:00.000Z');

describe('expiryDelay', () => {
  it('returns the time left for a near expiry', () => {
    expect(expiryDelay('2026-11-23T00:10:00.000Z', now)).toBe(600_000);
  });

  it('caps a far expiry at the longest delay a browser timer can hold', () => {
    expect(expiryDelay('2099-01-01T00:00:00.000Z', now)).toBe(
      MAX_TIMER_DELAY_MS,
    );
  });

  it('returns zero for a past or unreadable expiry', () => {
    expect(expiryDelay('2026-11-22T23:59:59.000Z', now)).toBe(0);
    expect(expiryDelay('not a date', now)).toBe(0);
  });
});
