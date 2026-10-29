import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ignored = new Set([
  'node_modules',
  'dist',
  'desktop-builds',
  'runtime',
  'backups',
  'logs',
  'coverage',
  'test-results',
  'playwright-report',
  '.git',
]);
const signatures = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:sk_live_|ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /["'](?:authorization|api[_-]?key|access[_-]?token|password)["']\s*:\s*["'](?:Bearer\s+)?[A-Za-z0-9+/_=-]{24,}["']/i,
];
let count = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(path);
    else if (
      /\.(?:[cm]?[jt]sx?|json|md|html|css|cs|ps1)$/.test(entry.name) &&
      entry.name !== 'package-lock.json'
    ) {
      const source = await readFile(path, 'utf8');
      if (signatures.some((pattern) => pattern.test(source)))
        throw new Error(`Possible credential found in ${path}. Value omitted.`);
      count++;
    }
  }
}
await walk('.');
console.info(
  `Credential signature scan passed (${count} source/fixture/config files). This is not a substitute for review.`,
);
