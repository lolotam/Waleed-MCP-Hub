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

export async function api<T>(
  path: string,
  body?: unknown,
  method?: 'DELETE',
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
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

export async function uploadBundle(file: File) {
  const response = await fetch('/api/bundles/preview', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: file,
  });
  if (!response.ok)
    throw new ApiError(
      'Bundle could not be inspected. Check the archive limits, manifest and supported launch configuration.',
      response.status,
    );
  return response.json() as Promise<import('@waleed/contracts').McpbPreview>;
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
