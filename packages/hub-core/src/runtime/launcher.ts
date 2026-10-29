import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ConnectorSchema, StateSchema, SafetyStateSchema } from '@waleed/contracts';
import { assertNoLinks } from '../adapters/managed-files.js';
import { approved, definitionHash, hashBytes } from './registry.js';
import { createWindowsProcessRunner } from '../adapters/native/process-runner.js';
import { isolatedNativeArguments } from '../adapters/mcp/runtime.js';
import { dirname, join } from 'node:path';
import { windowsSecretStore } from '../adapters/secrets/windows.js';
import { createBindingResolver, type SecretLease } from '../auth/bindings.js';

// Each agent connection invokes a fresh Node launcher and a fresh contained target
// tree with independent stdin/stdout. It never attaches to a dashboard process.
export async function runNativeLauncher(manifestUrl: URL, expectedHash: string) {
  const stop = new AbortController();
  let lease: SecretLease | undefined;
  try {
    if (!process.versions.node.startsWith('24.')) throw new Error();
    if (manifestUrl.protocol !== 'file:' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error();
    const path = fileURLToPath(manifestUrl); await assertNoLinks(path);
    if ((await lstat(path)).size > 1024 * 1024) throw new Error();
    const raw = await readFile(path, 'utf8'); if (hashBytes(raw) !== expectedHash) throw new Error();
    const manifest = JSON.parse(raw) as { version?: unknown; registryPath?: unknown; profileId?: unknown; connector?: unknown };
    if (manifest.version !== 1 || typeof manifest.registryPath !== 'string' || typeof manifest.profileId !== 'string') throw new Error();
    const saved = ConnectorSchema.parse(manifest.connector); await assertNoLinks(manifest.registryPath);
    if ((await lstat(manifest.registryPath)).size > 16 * 1024 * 1024) throw new Error();
    const state = StateSchema.parse(JSON.parse(await readFile(manifest.registryPath, 'utf8')));
    const safetyPath = join(dirname(manifest.registryPath), 'safety.json'); await assertNoLinks(safetyPath);
    if ((await lstat(safetyPath)).size > 1024 * 1024 || SafetyStateSchema.parse(JSON.parse(await readFile(safetyPath, 'utf8'))).operations.some((operation) => operation.phase === 'prepared' || operation.phase === 'needs_review')) throw new Error();
    const current = state.connectors.find((connector) => connector.id === saved.id);
    const profile = state.profiles.find((profile) => profile.id === manifest.profileId);
    if (!current || current.executionMode !== 'native' || !current.enabled || !profile || profile.enabled === false || !profile.connectorIds.includes(current.id) || !approved(current) || current.revision !== saved.revision || definitionHash(current) !== definitionHash(saved) || Object.keys(current.headerBindings).length) throw new Error();
    if (Object.keys(current.secretBindings).length) lease = await createBindingResolver({ windows: await windowsSecretStore(join(dirname(manifest.registryPath), 'credentials'), true) }, async () => state)(current, stop.signal);
    await assertNoLinks(current.executable);
    const runner = await createWindowsProcessRunner({ allowedExecutables: [current.executable], workingDirectory: dirname(path), concurrency: 1 });
    process.stdin.setEncoding('utf8'); let send: ((data: string) => void) | undefined;
    process.stdin.pause();
    const input = (data: string) => { if (send) { for (let offset = 0; offset < data.length; offset += 4096) send(data.slice(offset, offset + 4096)); } };
    process.stdin.on('data', input); process.stdin.once('end', () => stop.abort());
    process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
    const result = await runner.run({ executable: current.executable, arguments: isolatedNativeArguments(current), environment: { ...(current.environmentLiterals ?? {}), ...lease?.environment }, timeoutMs: 120_000, outputLimitBytes: 1024 * 1024, signal: stop.signal, stream: { started(write) { send = write; process.stdin.resume(); }, stdout(data) { process.stdout.write(data); } } });
    process.stdin.off('data', input); process.stdin.pause();
    if (result.outcome !== 'exited' && result.outcome !== 'cancelled') process.exitCode = 1;
  } catch { process.stderr.write('The approved native launcher is stale, disabled, unsafe, or unavailable. Re-preview its managed profile.\n'); process.exitCode = 1; stop.abort(); }
  finally { lease?.dispose(); }
}
