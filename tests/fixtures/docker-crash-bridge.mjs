// A bridge that launches one container through the production launch path
// and then dies without cleaning it up. The next bridge of the agent has to
// remove the orphan at its start.
//
// The fixture runs the hub-core sources: the liveness listener, the
// ownership manager, the transport of the container, the launching marker
// and the container id file are the production ones.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createDockerOwnership,
  listenBridge,
} from '../../packages/hub-core/src/integrations/docker-ownership.js';
import {
  createDockerSession,
  dockerAgentTransport,
} from '../../packages/hub-core/src/integrations/docker-transport.js';
import { readInstallRecord } from '../../packages/hub-core/src/runtime/boot.js';

const [directory, agentId, image, ...command] = process.argv.slice(2);

const install = await readInstallRecord(directory);
const bridgeId = randomUUID();
// The liveness listener of this bridge exists before any marker.
await listenBridge(install.installId, bridgeId);
const session = await createDockerSession(
  directory,
  AbortSignal.timeout(60_000),
);
const ownership = createDockerOwnership({
  docker: session.command,
  directory,
  agentId,
  bridgeId,
  installId: install.installId,
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle),
});
// The production launch: the transport names the container id file and the
// ownership labels of the run, and the marker is written before the CLI of
// the container starts.
const peer = await dockerAgentTransport(
  {
    id: 'connector-0',
    name: 'connector-0',
    description: 'A synthetic Docker connector.',
    enabled: true,
    revision: 1,
    secretBindings: {},
    headerBindings: {},
    trustApproval: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    executionMode: 'docker',
    transport: 'stdio',
    image,
    arguments: [],
    command,
  },
  AbortSignal.timeout(60_000),
  session,
  ownership,
);
// The CLI of the container starts the container.
await peer.transport.start();
// The acknowledgement moves the marker to `running`: the container of this
// session exists.
const folder = join(directory, 'owned-agent-containers', agentId, bridgeId);
let nonce = '';
for (let attempt = 0; attempt < 600 && !nonce; attempt++) {
  const files = await readdir(folder).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const body = JSON.parse(await readFile(join(folder, file), 'utf8'));
    if (body.phase === 'running') {
      nonce = body.nonce;
      break;
    }
  }
  if (!nonce) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!nonce) process.exit(1);
process.stdout.write(`started ${nonce}\n`);
// The bridge lives until it is killed.
await new Promise(() => {});
