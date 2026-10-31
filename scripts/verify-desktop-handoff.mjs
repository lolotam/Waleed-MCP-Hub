import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop } from './desktop-runtime.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'wmh-handoff-'));
const directory = join(temporary, 'data');
await mkdir(directory);
await writeFile(join(directory, 'preserved.txt'), 'existing-user-state');
const hosts = [];
const fixture = `
import {writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const lock=join(process.env.HUB_DATA_DIR,'writer.lock');
await writeFile(lock,JSON.stringify({pid:process.pid}));
process.on('message',async message=>{
  if(message==='shutdown'){await unlink(lock);process.disconnect();}
  if(message==='reopen')ready();
});
function ready(){process.send({launchUrl:'http://127.0.0.1:'+process.env.HUB_PORT+'/#launch='+randomBytes(32).toString('hex')});}
ready();
`;
async function start(name) {
  const root = join(temporary, name);
  await mkdir(join(root, 'apps/server/dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'apps/server/dist/main.js'), fixture);
  let ready;
  const opened = new Promise((resolve) => {
    ready = resolve;
  });
  const host = await startDesktop({
    root,
    directory,
    port: 4194,
    openWindow: () => ready(),
    environment: process.env,
    log: console.info,
  });
  hosts.push(host);
  await Promise.race([
    opened,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Desktop did not open.')),
        15000,
      );
      timer.unref();
    }),
  ]);
  return host;
}
try {
  const first = await start('version-a');
  const firstPid = first.pid;
  const replacement = await start('version-b');
  await first.closed;
  assert.equal(replacement.reused, false);
  assert.notEqual(replacement.pid, firstPid);
  assert.equal(
    JSON.parse(await readFile(join(directory, 'writer.lock'), 'utf8')).pid,
    replacement.pid,
  );
  assert.equal(
    await readFile(join(directory, 'preserved.txt'), 'utf8'),
    'existing-user-state',
  );
  replacement.stop();
  await replacement.closed;
  await assert.rejects(access(join(directory, 'writer.lock')));
  console.info(
    'Desktop version handoff verified: old backend exits, replacement starts, user state is preserved, and locks release.',
  );
} finally {
  for (const host of hosts) host.stop();
  await Promise.all(hosts.map((host) => host.closed));
}
