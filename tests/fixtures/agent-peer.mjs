import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const methods = [];
const accepted =
  process.env.PROVIDER_TOKEN === 'SYNTHETIC_AGENT_DPAPI_TOKEN' &&
  !process.env.UNRELATED_PROVIDER_TOKEN;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) methods.push(message.method);
  writeFileSync(process.argv[2], JSON.stringify({ accepted, methods }));
  if (message.id === undefined) return;
  if (!accepted) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'Synthetic credential unavailable.' },
      }) + '\n',
    );
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-agent-peer', version: '1' },
        }
      : message.method === 'tools/list'
        ? {
            tools: [
              { name: 'synthetic_echo', inputSchema: { type: 'object' } },
            ],
          }
        : {
            content: [
              { type: 'text', text: 'Synthetic explicit tool call succeeded.' },
            ],
          };
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n',
  );
});
