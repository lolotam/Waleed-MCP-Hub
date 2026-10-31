import type { DockerCommand } from '../docker-profile.js';
import { RuntimeFault } from '../../runtime/capabilities.js';

// The ownership labels of one container, read with inspect. A container that
// is gone, a daemon that is unavailable and a malformed answer are all
// "unknown": the caller confirms the absence separately.
export async function inspectContainerLabels(
  docker: DockerCommand,
  id: string,
  signal: AbortSignal,
): Promise<Record<string, string> | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await docker.run(
        ['inspect', '--format', '{{json .Config.Labels}}', id],
        signal,
      ),
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
    if (typeof value !== 'string') return null;
    else labels[key] = value;
  return labels;
}

// Removes one container by its immutable id. The ownership labels are
// inspected and confirmed first, the removal is recorded, the container is
// removed and its absence is confirmed before the caller deletes the marker.
export async function removeInspectedContainer(
  docker: DockerCommand,
  id: string,
  expected: Record<string, string>,
  options: {
    record?: (id: string) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error();
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  const labels = await inspectContainerLabels(docker, id, signal);
  if (!labels) throw new Error();
  for (const [key, value] of Object.entries(expected))
    if (labels[key] !== value) throw new Error();
  await options.record?.(id);
  await docker.run(['rm', '--force', id], signal);
  const listed = await docker.run(
    ['ps', '--all', '--quiet', '--no-trunc', '--filter', `id=${id}`],
    signal,
  );
  if (listed.trim()) throw new Error();
}

// Never remove by image/name, enumerate unrelated containers, or invoke prune.
// Immutable container IDs plus exact nonce/connector labels establish ownership.
// `record` is called with the inspected container id before the removal, so
// the owner can write the `removing` step first.
//
// The result tells whether a container passed through the recorded removal:
// an empty listing removes nothing, so the caller keeps its marker and the
// recovery owns the session. The expected labels add the ownership evidence
// of the installation, the agent and the bridge to the nonce and the
// connector.
export async function cleanupOwnedContainers(
  docker: DockerCommand,
  nonce: string,
  connectorId: string,
  record?: (id: string) => Promise<void>,
  options: {
    signal?: AbortSignal;
    expected?: Record<string, string>;
  } = {},
): Promise<boolean> {
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  let removed = false;
  try {
    if (
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(connectorId)
    )
      throw new Error();
    const list = [
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=wmh.client=${nonce}`,
    ];
    const raw = await docker.run(list, signal);
    const ids = raw.trim() ? raw.trim().split(/\s+/) : [];
    if (ids.length > 16 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
      throw new Error();
    for (const id of ids) {
      const labels: unknown = JSON.parse(
        await docker.run(
          ['inspect', '--format', '{{json .Config.Labels}}', id],
          signal,
        ),
      );
      if (
        !labels ||
        typeof labels !== 'object' ||
        (labels as Record<string, unknown>)['wmh.client'] !== nonce ||
        (labels as Record<string, unknown>)['wmh.connector'] !== connectorId
      )
        throw new Error();
      for (const [key, value] of Object.entries(options.expected ?? {}))
        if ((labels as Record<string, unknown>)[key] !== value)
          throw new Error();
      await record?.(id);
      await docker.run(['rm', '--force', id], signal);
      // The absence of the container is confirmed before the caller deletes
      // its marker.
      const listed = await docker.run(
        [
          'ps',
          '--all',
          '--quiet',
          '--no-trunc',
          '--filter',
          `label=wmh.client=${nonce}`,
          '--filter',
          `id=${id}`,
        ],
        signal,
      );
      if (listed.trim()) throw new Error();
      removed = true;
    }
  } catch {
    throw new RuntimeFault('dependency_unavailable', true);
  }
  return removed;
}
