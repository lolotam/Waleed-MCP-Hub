// The teardown of a real-daemon test: it removes only the containers this test
// launched, and nothing when the launch never reported its nonce.
export type DockerCli = (
  args: string[],
) => Promise<{ code: number; stdout: string }>;

const lowerUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const containerId = /^[0-9a-f]{64}$/;

export async function removeTestContainers(
  cli: DockerCli,
  owner: { installId: string; agentId: string; nonce: string },
): Promise<void> {
  // An empty or malformed nonce would match foreign containers.
  if (!lowerUuid.test(owner.nonce) || !lowerUuid.test(owner.installId)) return;
  const listed = await cli([
    'ps',
    '--all',
    '--quiet',
    '--no-trunc',
    '--filter',
    `label=wmh.install=${owner.installId}`,
    '--filter',
    `label=wmh.agent=${owner.agentId}`,
    '--filter',
    `label=wmh.client=${owner.nonce}`,
  ]);
  if (listed.code !== 0) return;
  // A removal that fails leaves a test container behind: the teardown
  // reports it instead of passing in silence.
  const failed: string[] = [];
  for (const id of listed.stdout.split(/\s+/).filter(Boolean)) {
    if (!containerId.test(id)) continue;
    const inspected = await cli([
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      id,
    ]);
    if (inspected.code !== 0) continue;
    let labels: Record<string, string> | null;
    try {
      labels = JSON.parse(inspected.stdout) as Record<string, string> | null;
    } catch {
      continue;
    }
    if (
      labels?.['wmh.install'] !== owner.installId ||
      labels['wmh.agent'] !== owner.agentId ||
      labels['wmh.client'] !== owner.nonce
    )
      continue;
    const removed = await cli(['rm', '--force', id]);
    if (removed.code !== 0) failed.push(id);
  }
  if (failed.length > 0)
    throw new Error(
      `The teardown could not remove the test containers ${failed.join(', ')}.`,
    );
}
