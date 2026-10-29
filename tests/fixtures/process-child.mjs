// Synthetic programs only. These fixtures do not access Docker, agent configs,
// network services, browser sessions, or actual credentials.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'arguments') {
  process.stdout.write(
    JSON.stringify({
      arguments: args,
      cwd: process.cwd(),
      declared: process.env.SYNTHETIC_DECLARED,
      inherited: process.env.SYNTHETIC_HOST_ONLY ?? null,
    }),
  );
  process.stderr.write('fixture stderr');
} else if (mode === 'stdin') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () =>
    process.stdout.write(
      JSON.stringify({
        bytes: Buffer.byteLength(input),
        sha256: createHash('sha256').update(input).digest('hex'),
      }),
    ),
  );
} else if (mode === 'nonzero') {
  process.exitCode = 7;
} else if (mode === 'flood') {
  const output = 'x'.repeat(8192);
  setInterval(() => {
    process.stdout.write(output);
    process.stderr.write(output);
  }, 1);
} else if (mode === 'tree' || mode === 'crash-host') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    shell: false,
  });
  writeFileSync(
    args[0],
    JSON.stringify({ root: process.pid, child: child.pid }),
  );
  process.stdout.write('tree ready');
  if (mode === 'crash-host') setTimeout(() => process.kill(process.ppid), 750);
  setInterval(() => {}, 1000);
} else if (mode === 'hold') {
  process.stdout.write('holding');
  setInterval(() => {}, 1000);
} else if (mode === 'exit-with-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    shell: false,
  });
  writeFileSync(args[0], JSON.stringify({ child: child.pid }));
  child.unref();
} else {
  throw new Error('Unknown synthetic fixture mode.');
}
