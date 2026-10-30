import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListToolsResultSchema, ListResourcesResultSchema, ListPromptsResultSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CapabilityObservation, Connector } from '@waleed/contracts';

export class RuntimeFault extends Error {
  constructor(readonly reason: CapabilityObservation['reason'], readonly uncertain = false) { super('Bounded MCP operation failed.'); }
}
export type Capabilities = Pick<CapabilityObservation, 'protocolVersion' | 'tools' | 'resourceCount' | 'promptCount'>;
export interface CapabilityRuntime { discover(connector: Connector, signal: AbortSignal, options?:{allowInstall:boolean}): Promise<Capabilities> }
const allowed = new Set(['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list', 'ping', 'notifications/cancelled']);
export function assertDiscoveryMessage(message: JSONRPCMessage) {
  if ('method' in message && !allowed.has(message.method)) throw new RuntimeFault('protocol_error');
}
const management = new Set(['mcp-add', 'mcp-remove', 'mcp-exec', 'mcp-find', 'mcp-config-set', 'mcp-create-profile', 'mcp-select-profile', 'mcp-list-profiles', 'mcp-delete-profile']);
export async function enumerateCapabilities(transport: Transport, signal: AbortSignal): Promise<Capabilities> {
  const client = new Client({ name: 'waleed-hub-discovery', version: '0.1.0' }, { capabilities: {}, enforceStrictCapabilities: true });
  let version: string | null = null;
  const setVersion = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (value) => { version = value; setVersion?.(value); };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => { assertDiscoveryMessage(message); return send(message, options); };
  // The SDK negotiates supported protocol versions and rejects server-initiated
  // sampling/roots/elicitation because this client advertises none of them.
  try {
    await client.connect(transport, { signal, timeout: 5000, maxTotalTimeout: 20_000 });
    const capabilities = client.getServerCapabilities() ?? {};
    const options = { signal, timeout: 5000, maxTotalTimeout: 20_000 };
    const tools: Capabilities['tools'] = [];
    let resourceCount = 0, promptCount = 0;
    for (const category of ['tools', 'resources', 'prompts'] as const) {
      if (!capabilities[category]) continue;
      let cursor: string | undefined; const seen = new Set<string>(); let complete = false;
      for (let page = 0; page < 8; page++) {
        const params = cursor === undefined ? {} : { cursor };
        if (category === 'tools') {
          // Do not precompile arbitrary tool-result schemas, read resources, get
          // prompts, or call tools. Return bounded metadata, not schemas/prose.
          const result = await client.request({ method: 'tools/list', params }, ListToolsResultSchema, options);
          for (const tool of result.tools) {
            if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(tool.name) || tools.some((item) => item.name === tool.name)) throw new RuntimeFault('protocol_error');
            tools.push({ name: tool.name, role: management.has(tool.name) || tool.name.startsWith('mcp-') ? 'gateway_management' : 'upstream' });
          }
          cursor = result.nextCursor;
        } else if (category === 'resources') {
          const result = await client.request({ method: 'resources/list', params }, ListResourcesResultSchema, options); resourceCount += result.resources.length; cursor = result.nextCursor;
        } else {
          const result = await client.request({ method: 'prompts/list', params }, ListPromptsResultSchema, options); promptCount += result.prompts.length; cursor = result.nextCursor;
        }
        if (tools.length > 256 || resourceCount > 256 || promptCount > 256 || cursor !== undefined && (cursor.length > 256 || seen.has(cursor))) throw new RuntimeFault('limit_exceeded');
        if (!cursor) { complete = true; break; } seen.add(cursor);
      }
      if (!complete) throw new RuntimeFault('limit_exceeded');
    }
    return { protocolVersion: version, tools, resourceCount, promptCount };
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    if (error && typeof error === 'object' && 'code' in error && (error.code === 401 || error.code === 403)) throw new RuntimeFault('auth_required');
    if (error instanceof Error && error.name === 'UnauthorizedError') throw new RuntimeFault('auth_required');
    throw new RuntimeFault(signal.aborted ? 'cancelled' : 'protocol_error');
  } finally { await client.close().catch(() => undefined); }
}
