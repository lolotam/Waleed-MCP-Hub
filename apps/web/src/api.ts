import { SessionResponseSchema } from '@waleed/contracts';

let csrfToken: string | null = null;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
// Consume and erase the fragment before any async work. Never use browser storage.
let launchToken = new URLSearchParams(window.location.hash.slice(1)).get(
  'launch',
);
if (window.location.hash)
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search,
  );

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new ApiError(
      error?.message ??
        'The local hub is unavailable. Check the terminal and retry.',
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

// A single promise also prevents React development remounts from consuming twice.
export const sessionReady = (async () => {
  const token = launchToken;
  launchToken = null;
  const session = SessionResponseSchema.parse(
    token ? await api('/api/session', { token }) : await api('/api/session'),
  );
  csrfToken = session.csrfToken;
})();
