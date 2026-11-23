// Browsers keep a timer delay in a signed 32-bit number of milliseconds. A
// longer delay wraps around and the timer can fire at once.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Milliseconds to wait before treating something as expired: never negative,
// never longer than a browser timer can hold. A date that cannot be read
// counts as already expired.
export function expiryDelay(expiresAt: string, now = Date.now()): number {
  const left = Date.parse(expiresAt) - now;
  if (Number.isNaN(left)) return 0;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, left));
}
