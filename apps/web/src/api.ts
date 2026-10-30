import {
  PackageErrorCodeSchema,
  PackageJobSchema,
  SessionResponseSchema,
  type PackageErrorCode,
  type PackageJob,
  type PackageWarning,
} from '@waleed/contracts';

let csrfToken: string | null = null;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
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
      error?: unknown;
      message?: string;
    } | null;
    throw new ApiError(
      error?.message ??
        'The local hub is unavailable. Check the terminal and retry.',
      response.status,
      typeof error?.error === 'string' ? error.error : undefined,
    );
  }
  return response.json() as Promise<T>;
}

// The sanitized failure texts of a package job. Only this text ever reaches
// the screen: nothing else of a failed job is shown, logged or returned.
const packageErrorTexts: Record<PackageErrorCode, string> = {
  package_not_found: 'No package with that name exists in the npm registry.',
  version_not_found: 'No release matches that version, range or tag.',
  no_entry: 'The package has no command to run (no bin entry).',
  entry_required: 'Pick which command of the package to run.',
  unsupported_dependency:
    'A dependency is not a registry package (git, URL, file or alias), so the hub refuses it.',
  registry_unavailable:
    'The npm registry could not be reached. Try again later.',
  foreign_host:
    'The install tried to reach a host other than the npm registry and was stopped.',
  install_failed: 'npm could not install the package.',
  install_limit:
    'The package is too large (size, file count, package count or free disk space).',
  integrity_mismatch:
    'The downloaded files do not match the registry checksums.',
  preview_expired: 'This preview has expired. Look up the package again.',
  warning_not_acknowledged: 'Tick every warning before installing.',
  package_modified: 'The installed files have changed since install.',
  invalid_configuration:
    'The connector definition does not match its package record.',
  save_uncertain:
    'The install finished but saving could not be confirmed. Reload the connector list before retrying.',
  busy: 'Another package job is running. Try again in a moment.',
  cancelled: 'Cancelled.',
};

export function packageErrorText(code: PackageErrorCode): string {
  return packageErrorTexts[code];
}

// The text of a failed package request. A package view never shows the
// message of a response: only the fixed sentence of its code or status.
export function packageFailureText(failure: unknown): string {
  if (!(failure instanceof ApiError))
    return 'The local hub is unavailable. Check the terminal and retry.';
  const code = PackageErrorCodeSchema.safeParse(failure.code);
  if (code.success) return packageErrorText(code.data);
  if (failure.status === 429) return packageErrorText('busy');
  if (failure.status === 503) return 'Managed packages are not available.';
  if (failure.status === 409)
    return 'The hub state changed or needs recovery review. Reload and retry.';
  if (failure.status >= 400 && failure.status < 500)
    return 'The hub refused this request. Check the fields and retry.';
  return 'The package request failed. Check the terminal and retry.';
}

// One sentence per warning of a preview. Every warning must be ticked before
// the install is allowed to run.
const packageWarningTexts: Record<PackageWarning, string> = {
  install_scripts:
    'This package has install scripts. They will NOT run, so it may not work without them.',
  install_scripts_unknown:
    'Whether this package has install scripts is unknown. They will not run.',
  optional_omitted: 'Optional dependencies are omitted and are not installed.',
  recent_release: 'This release is younger than 7 days.',
  release_date_unknown: 'The release date of this version is unknown.',
  deprecated: 'This release is deprecated.',
  engine_mismatch: 'The declared Node engines do not match this runtime.',
  many_packages: 'The dependency tree holds more than 300 packages.',
  large_size: 'The unpacked size is larger than 200 MiB.',
  size_unknown: 'The unpacked size is unknown.',
};

export function packageWarningText(warning: PackageWarning): string {
  return packageWarningTexts[warning];
}

// The poll of a package job: every half second the job is read again while
// it is queued or running. The signal stops the loop when the view goes away.
export async function pollPackageJob(
  job: PackageJob,
  onUpdate: (job: PackageJob) => void,
  signal?: AbortSignal,
): Promise<PackageJob> {
  let current = job;
  onUpdate(current);
  while (current.state === 'queued' || current.state === 'running') {
    if (signal?.aborted) return current;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    if (signal?.aborted) return current;
    current = PackageJobSchema.parse(
      await api<PackageJob>(`/api/packages/jobs/${current.id}`),
    );
    onUpdate(current);
  }
  return current;
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
