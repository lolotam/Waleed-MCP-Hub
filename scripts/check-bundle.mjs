import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = 'apps/web/dist/assets';
const scripts = (await readdir(directory)).filter((name) =>
  name.endsWith('.js'),
);
if (!scripts.length)
  throw new Error('Build the web application before checking its bundle.');
for (const name of scripts) {
  const source = await readFile(join(directory, name), 'utf8');
  for (const forbidden of [
    'node:child_process',
    'node:fs',
    'writer.lock',
    'openStateStore',
    'powershell.exe',
    'timingSafeEqual',
    'CreateProcessW',
    'TerminateJobObject',
    'ProcessHost',
    'safety.lock',
    'openSafetyLedger',
  ]) {
    if (source.includes(forbidden))
      throw new Error(
        `Backend implementation marker in browser bundle: ${forbidden}`,
      );
  }
}
console.info(`Browser bundle check passed (${scripts.length} local scripts).`);
