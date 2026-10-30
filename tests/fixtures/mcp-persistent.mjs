import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// A synthetic stateful MCP with a descendant to prove Job Object cleanup.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
await writeFile(
  process.argv[2],
  JSON.stringify({ root: process.pid, child: child.pid }),
);
let opened = false;
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize')
    result = {
      protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'synthetic-stateful-peer', version: '1' },
    };
  else if (m.method === 'tools/list')
    result = {
      tools: ['open-session', 'read-session-output'].map((name) => ({
        name,
        inputSchema: { type: 'object' },
      })),
    };
  else if (m.method === 'tools/call') {
    if (m.params.name === 'open-session') opened = true;
    result = {
      content: [
        {
          type: 'text',
          text: opened
            ? 'synthetic session retained'
            : 'synthetic session missing',
        },
      ],
    };
  } else result = {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n',
  );
});
// Deliberately leave the descendant behind. The containment host must reap it
// even when the root exits normally after graceful stdin EOF.
input.on('close', () => {
  writeFileSync(process.argv[2] + '.closed', 'graceful EOF');
  process.exit(0);
});
