import { randomBytes, timingSafeEqual } from 'node:crypto';

const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createSessions(now: () => number = Date.now) {
  let launch: { value: string; expiresAt: number } | undefined;
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  let attempts = 0;
  let attemptWindow = now();
  const prune = () => {
    for (const [id, session] of sessions)
      if (session.expiresAt <= now()) sessions.delete(id);
  };
  return {
    issueLaunchToken() {
      launch = { value: token(), expiresAt: now() + 120_000 };
      return launch.value;
    },
    consume(value: string) {
      if (now() - attemptWindow >= 60_000) {
        attempts = 0;
        attemptWindow = now();
      }
      if (++attempts > 20) return null;
      prune();
      if (
        !launch ||
        launch.expiresAt <= now() ||
        !equal(launch.value, value) ||
        sessions.size >= 10
      )
        return null;
      launch = undefined;
      const id = token();
      const csrf = token();
      sessions.set(id, { csrf, expiresAt: now() + 8 * 60 * 60_000 });
      return { id, csrf };
    },
    get(id: string | undefined) {
      prune();
      return id ? sessions.get(id) : undefined;
    },
    verifyCsrf(id: string, csrf: string) {
      const session = this.get(id);
      return session !== undefined && equal(session.csrf, csrf);
    },
    revoke(id: string) {
      sessions.delete(id);
    },
    clear() {
      sessions.clear();
      launch = undefined;
    },
  };
}
