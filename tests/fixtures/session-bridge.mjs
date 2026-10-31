// The compiled bridge, started the way the production bridge command starts
// it: the registry and the agent id come from the command line. The optional
// third argument shortens the idle limit of the pool for the lifetime test;
// the production bridge command never passes it.
import { runAgentBridge } from '@waleed/hub-core';

const [registry, agentId, idleMs] = process.argv.slice(2);

await runAgentBridge(
  registry,
  agentId,
  idleMs === undefined ? undefined : { limits: { idleMs: Number(idleMs) } },
);
