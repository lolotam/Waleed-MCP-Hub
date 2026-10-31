// The next bridge of the agent, started through the production startup: the
// recovery of the agent runs at its start and removes the orphan of the
// crashed bridge.
import { runAgentBridge } from '../../packages/hub-core/src/integrations/bridge.js';

const [registry, agentId] = process.argv.slice(2);

await runAgentBridge(registry, agentId);
