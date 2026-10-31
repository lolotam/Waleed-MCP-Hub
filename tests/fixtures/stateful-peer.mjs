// A stateful stdio MCP peer that proves containment on Windows: it spawns a
// grandchild outside its own lifetime and records the three process ids of
// its tree in an evidence file. The counter lives in this process, so two
// calls over one connection answer 1 and 2.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [evidencePath, initializeDelay] = process.argv.slice(2);

// The grandchild outlives its parent unless the whole tree is contained. It
// is not detached, so it stays in the job object of the process host.
const grandchild = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1e9)'],
  { detached: false, stdio: 'ignore', windowsHide: true },
);
grandchild.unref();

writeFileSync(
  evidencePath,
  JSON.stringify({
    server: process.pid,
    host: process.ppid,
    grandchild: grandchild.pid,
  }),
);

let count = 0;
const initializeDelayMs = initializeDelay ? Number(initializeDelay) : 0;

const send = (id, result) => {
  try {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  } catch {
    /* The peer may be gone before the answer is written. */
  }
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    const answer = () =>
      send(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-stateful-peer', version: '1' },
      });
    if (initializeDelayMs > 0) setTimeout(answer, initializeDelayMs);
    else answer();
    return;
  }
  if (message.method === 'tools/list') {
    send(message.id, {
      tools: [
        {
          name: 'count',
          description: 'Returns the in-process counter.',
          inputSchema: { type: 'object' },
        },
      ],
    });
    return;
  }
  if (message.method === 'ping') {
    send(message.id, {});
    return;
  }
  send(message.id, { content: [{ type: 'text', text: String(++count) }] });
});
