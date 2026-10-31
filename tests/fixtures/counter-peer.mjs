// A stateful stdio MCP peer: the counter lives in this process, so three
// calls over one connection answer 1, 2 and 3.
import { createInterface } from 'node:readline';
let count = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-counter-peer', version: '1' },
        }
      : message.method === 'tools/list'
        ? {
            tools: [
              {
                name: 'increment',
                description: 'Returns the in-process counter.',
                inputSchema: { type: 'object' },
              },
            ],
          }
        : {
            content: [{ type: 'text', text: String(++count) }],
          };
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n',
  );
});
