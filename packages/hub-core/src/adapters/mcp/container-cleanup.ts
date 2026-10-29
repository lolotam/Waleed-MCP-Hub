import type { DockerCommand } from '../docker-profile.js';
import { RuntimeFault } from '../../runtime/capabilities.js';

// Never remove by image/name, enumerate unrelated containers, or invoke prune.
// Immutable container IDs plus exact nonce/connector labels establish ownership.
export async function cleanupOwnedContainers(
  docker: DockerCommand,
  nonce: string,
  connectorId: string,
) {
  try {
    if (
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(connectorId)
    )
      throw new Error();
    const signal = AbortSignal.timeout(30_000);
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
      await docker.run(['rm', '--force', id], signal);
    }
    if ((await docker.run(list, signal)).trim()) throw new Error();
  } catch {
    throw new RuntimeFault('dependency_unavailable', true);
  }
}
