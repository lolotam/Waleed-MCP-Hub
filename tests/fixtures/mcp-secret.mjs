import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const expected = 'SYNTHETIC_NATIVE_DPAPI_0123456789';
const methods = [];
const accepted =
  process.env.PROVIDER_TOKEN === expected &&
  !process.env.UNRELATED_PROVIDER_TOKEN;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) methods.push(message.method);
  // Reports contain boolean evidence only, never the credential itself.
  writeFileSync(process.argv[2], JSON.stringify({ accepted, methods }));
  if (message.id === undefined) return;
  if (!accepted) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'Synthetic credential rejected' },
      }) + '\n',
    );
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-secret-peer', version: '1' },
        }
      : {
          tools: [
            { name: 'fixture_secret_read', inputSchema: { type: 'object' } },
          ],
        };
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n',
  );
});
