import { describe, expect, it } from 'vitest';
import {
  removeTestContainers,
  type DockerCli,
} from './helpers/docker-test-cleanup.js';

const installId = '11111111-1111-4111-8111-111111111111';
const nonce = '22222222-2222-4222-8222-222222222222';
const own = 'a'.repeat(64);
const foreign = 'b'.repeat(64);

// A recording CLI whose listing and inspection are scripted.
function recording(
  labels: Record<string, Record<string, string>>,
  listing: string[],
  removalCode = 0,
) {
  const calls: string[][] = [];
  const cli: DockerCli = async (args) => {
    calls.push(args);
    if (args[0] === 'rm') return { code: removalCode, stdout: '' };
    if (args[0] === 'ps') return { code: 0, stdout: listing.join('\n') };
    if (args[0] === 'inspect') {
      const id = args[args.length - 1] ?? '';
      return { code: 0, stdout: JSON.stringify(labels[id] ?? null) };
    }
    return { code: 0, stdout: '' };
  };
  const removed = () =>
    calls.filter((call) => call[0] === 'rm').map((call) => call[2]);
  return { cli, calls, removed };
}

describe('the teardown of the real-daemon test', () => {
  it('removes nothing when the bridge never reported its nonce', async () => {
    const docker = recording({ [foreign]: { 'wmh.client': '' } }, [foreign]);
    await removeTestContainers(docker.cli, {
      installId,
      agentId: 'opencode',
      nonce: '',
    });
    expect(docker.calls).toHaveLength(0);
  });

  it('scopes the listing to the test installation, agent and nonce', async () => {
    const docker = recording({}, []);
    await removeTestContainers(docker.cli, {
      installId,
      agentId: 'opencode',
      nonce,
    });
    expect(docker.calls[0]).toEqual(
      expect.arrayContaining([
        `label=wmh.install=${installId}`,
        'label=wmh.agent=opencode',
        `label=wmh.client=${nonce}`,
      ]),
    );
  });

  it('removes only a listed container whose labels it inspected', async () => {
    const docker = recording(
      {
        [own]: {
          'wmh.install': installId,
          'wmh.agent': 'opencode',
          'wmh.client': nonce,
        },
        [foreign]: {
          'wmh.install': '33333333-3333-4333-8333-333333333333',
          'wmh.agent': 'opencode',
          'wmh.client': nonce,
        },
      },
      [own, foreign],
    );
    await removeTestContainers(docker.cli, {
      installId,
      agentId: 'opencode',
      nonce,
    });
    expect(docker.removed()).toEqual([own]);
  });

  it('reports a removal that failed instead of passing in silence', async () => {
    const docker = recording(
      {
        [own]: {
          'wmh.install': installId,
          'wmh.agent': 'opencode',
          'wmh.client': nonce,
        },
      },
      [own],
      1,
    );
    await expect(
      removeTestContainers(docker.cli, {
        installId,
        agentId: 'opencode',
        nonce,
      }),
    ).rejects.toThrow(own);
    expect(docker.removed()).toEqual([own]);
  });
});
