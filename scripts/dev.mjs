import { spawn, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) !== 24)
  throw new Error('Use Node.js 24 LTS.');
const root = fileURLToPath(new URL('../', import.meta.url));
let server;
// One origin in dev and production. Restart this command after edits; do not
// weaken Host/Origin/CSP rules for HMR or kill a state writer during a reload.
const build = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'build',
    '--config',
    'apps/web/vite.config.ts',
  ],
  { cwd: root, stdio: 'inherit', shell: false },
);
build.on('exit', (code) => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  server = fork('apps/server/src/main.ts', [], {
    cwd: root,
    execArgv: ['--conditions=development', '--import', 'tsx'],
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  server.on('exit', (exitCode) => {
    process.exitCode = exitCode ?? 1;
  });
});
const stop = () => {
  if (server?.connected) server.send('shutdown');
  else if (build.exitCode === null) build.kill();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
