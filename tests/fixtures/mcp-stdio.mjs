// Synthetic MCP peer; never imports a provider or calls an external endpoint.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const [path, mode = 'healthy'] = process.argv.slice(2);
const methods = [];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    methods.push(message.method);
    if (path)
      writeFileSync(
        path,
        JSON.stringify({
          methods,
          arguments: process.argv.slice(4),
          inheritedSecret: process.env.SYNTHETIC_PROVIDER_SECRET ?? null,
        }),
      );
  }
  if (!message.method || message.id === undefined || mode === 'stall') return;
  let result = {};
  if (message.method === 'initialize') {
    result = {
      protocolVersion:
        mode === 'version' ? '1900-01-01' : message.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: `fixture-${process.pid}`, version: '1.0.0' },
    };
    if (mode === 'large') {
      process.stdout.write('x'.repeat(1024 * 1024 + 1));
      return;
    }
  }
  if (message.method === 'tools/list')
    result = {
      tools: [
        {
          name: message.params?.cursor ? 'fixture_second' : 'fixture_first',
          inputSchema: { type: 'object' },
        },
      ],
      ...(message.params?.cursor ? {} : { nextCursor: 'second' }),
    };
  if (message.method === 'resources/list')
    result = {
      resources: [{ uri: 'fixture://resource', name: 'fixture resource' }],
    };
  if (message.method === 'prompts/list')
    result = { prompts: [{ name: 'fixture_prompt' }] };
  send({ jsonrpc: '2.0', id: message.id, result });
});
