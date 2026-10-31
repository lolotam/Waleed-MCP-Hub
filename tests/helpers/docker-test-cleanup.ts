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
  // A listing that fails could hide a container this test left running:
  // the teardown reports it instead of passing in silence.
  const list = async () => {
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
    if (listed.code !== 0)
      throw new Error('The teardown could not list the test containers.');
    return listed.stdout.split(/\s+/).filter((id) => containerId.test(id));
  };
  // A removal that fails leaves a test container behind, and so does one
  // whose labels could not be read while it still exists.
  const failed: string[] = [];
  const unread: string[] = [];
  for (const id of await list()) {
    const inspected = await cli([
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      id,
    ]);
    let labels: Record<string, string> | null;
    try {
      if (inspected.code !== 0) throw new Error();
      labels = JSON.parse(inspected.stdout) as Record<string, string> | null;
    } catch {
      unread.push(id);
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
  // A container that was gone before its inspection is no failure.
  if (unread.length > 0) {
    const remaining = new Set(await list());
    failed.push(...unread.filter((id) => remaining.has(id)));
  }
  if (failed.length > 0)
    throw new Error(
      `The teardown could not remove the test containers ${failed.join(', ')}.`,
    );
}
