import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubError } from '../../errors.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../../ports.js';

export interface WindowsRunnerOptions {
  allowedExecutables: readonly string[];
  workingDirectory: string;
  concurrency?: number;
  // The ceiling of this runner: a package install needs ten minutes, an MCP
  // target keeps the two minutes it always had.
  maxTimeoutMs?: number;
}

// The default ceiling of every runner that does not ask for a longer one.
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
// No run may be shorter than this and none may be longer than ten minutes.
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 600_000;

const invalid = () =>
  new HubError(
    'invalid',
    'Use an approved absolute local .exe, explicit arguments/environment, and bounded process limits. Shell scripts and .cmd/.bat shims are unsupported.',
  );
const unavailable = () =>
  new HubError(
    'unavailable',
    'The Windows owned-process host failed or is unsupported. No uncontained execution fallback was used.',
  );
const localPath = (value: string) =>
  /^[a-z]:[\\/]/i.test(value) && !/[\0\r\n]/.test(value);
const emptyResult = (outcome: ProcessResult['outcome']): ProcessResult => ({
  outcome,
  exitCode: null,
  stdout: '',
  stderr: '',
});

function validate(request: ProcessRequest, maxTimeoutMs: number) {
  if (
    request.stream &&
    (typeof request.stream.started !== 'function' ||
      typeof request.stream.stdout !== 'function' ||
      request.stdin !== undefined)
  )
    throw invalid();
  if (
    request.stdin !== undefined &&
    (typeof request.stdin !== 'string' ||
      Buffer.byteLength(request.stdin, 'utf8') > 32 * 1024)
  )
    throw invalid();
  if (
    !localPath(request.executable) ||
    win32.extname(request.executable).toLowerCase() !== '.exe'
  )
    throw invalid();
  if (
    !Array.isArray(request.arguments) ||
    request.arguments.length > 128 ||
    request.arguments.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length > 4096 ||
        argument.includes('\0'),
    )
  )
    throw invalid();
  if (
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < MIN_TIMEOUT_MS ||
    request.timeoutMs > maxTimeoutMs ||
    !Number.isInteger(request.outputLimitBytes) ||
    request.outputLimitBytes < 1 ||
    request.outputLimitBytes > 1024 * 1024
  )
    throw invalid();
  const entries = Object.entries(request.environment);
  if (
    entries.length > 64 ||
    new Set(entries.map(([key]) => key.toLowerCase())).size !==
      entries.length ||
    entries.some(
      ([key, value]) =>
        !/^[a-z_][a-z0-9_]*$/i.test(key) ||
        typeof value !== 'string' ||
        value.length > 8192 ||
        value.includes('\0'),
    )
  )
    throw invalid();
}

export async function createWindowsProcessRunner(
  options: WindowsRunnerOptions,
): Promise<ProcessRunner> {
  if (process.platform !== 'win32') throw unavailable();
  const concurrency = options.concurrency ?? 2;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !Number.isInteger(maxTimeoutMs) ||
    maxTimeoutMs < MIN_TIMEOUT_MS ||
    maxTimeoutMs > MAX_TIMEOUT_MS ||
    options.allowedExecutables.length < 1 ||
    options.allowedExecutables.length > 16 ||
    !localPath(options.workingDirectory)
  )
    throw invalid();
  const directory = await realpath(options.workingDirectory).catch(() => {
    throw invalid();
  });
  if (!(await stat(directory)).isDirectory() || !localPath(directory))
    throw invalid();
  const approved = new Set<string>();
  for (const executable of options.allowedExecutables) {
    if (
      !localPath(executable) ||
      win32.extname(executable).toLowerCase() !== '.exe'
    )
      throw invalid();
    const canonical = await realpath(executable).catch(() => {
      throw invalid();
    });
    if (
      !localPath(canonical) ||
      win32.extname(canonical).toLowerCase() !== '.exe' ||
      !(await stat(canonical)).isFile()
    )
      throw invalid();
    approved.add(canonical.toLowerCase());
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (!localPath(systemRoot)) throw unavailable();
  const hostExecutable = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const hostScript = fileURLToPath(
    new URL('./windows/host.ps1', import.meta.url),
  );
  try {
    if (
      !(await stat(hostExecutable)).isFile() ||
      !(await stat(hostScript)).isFile() ||
      !(
        await stat(
          fileURLToPath(new URL('./windows/ProcessHost.cs', import.meta.url)),
        )
      ).isFile()
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
  // Do not propagate the manager's provider/API credentials, NODE_OPTIONS,
  // PSModulePath, or other inherited user environment into the process host.
  const hostEnvironment: Record<string, string> = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
  };
  for (const name of ['TEMP', 'TMP'])
    if (process.env[name]) hostEnvironment[name] = process.env[name]!;
  let active = 0;

  return {
    async run(request) {
      validate(request, maxTimeoutMs);
      // Snapshot before the first await: edits to a caller-owned definition must
      // not change a command/environment after it has passed validation.
      request = {
        ...request,
        arguments: [...request.arguments],
        environment: { ...request.environment },
      };
      if (request.signal.aborted) return emptyResult('cancelled');
      const deadline = Date.now() + request.timeoutMs;
      const executable = await realpath(request.executable).catch(() => {
        throw invalid();
      });
      if (!approved.has(executable.toLowerCase())) throw invalid();
      if (request.signal.aborted) return emptyResult('cancelled');
      if (active >= concurrency)
        throw new HubError(
          'busy',
          'The bounded process concurrency limit has been reached.',
        );
      // This adapter accepts only declared target environment, plus the minimum
      // Windows runtime variables. Case-insensitive override semantics are explicit.
      const environment = new Map(
        Object.entries(hostEnvironment).map(([key, value]) => [
          key.toLowerCase(),
          [key, value] as const,
        ]),
      );
      for (const [key, value] of Object.entries(request.environment))
        environment.set(key.toLowerCase(), [key, value]);
      const payload = JSON.stringify({
        Executable: executable,
        Arguments: request.arguments,
        Environment: Object.fromEntries(environment.values()),
        StandardInput: request.stdin ?? null,
        Duplex: !!request.stream,
        WorkingDirectory: directory,
        Deadline: deadline,
        OutputLimitBytes: request.outputLimitBytes,
      });
      if (Buffer.byteLength(payload, 'utf8') > 64 * 1024) throw invalid();
      active++;
      try {
        return await new Promise<ProcessResult>((resolve, reject) => {
          const child = spawn(
            hostExecutable,
            ['-NoProfile', '-NonInteractive', '-File', hostScript],
            {
              shell: false,
              windowsHide: true,
              cwd: directory,
              env: hostEnvironment,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          const stdout: Buffer[] = [],
            stderr: Buffer[] = [];
          let retained = 0,
            hostErrorBytes = 0;
          let pending = Buffer.alloc(0);
          let result: ProcessResult | undefined;
          let failure = false,
            closed = false;
          let reason: ProcessResult['outcome'] | undefined;
          let inputBytes = 0;
          let started = false;
          let grace: ReturnType<typeof setTimeout> | undefined;
          const stop = (outcome: ProcessResult['outcome']) => {
            if (closed || reason) return;
            reason = outcome;
            child.stdin.write('cancel\n', () => undefined);
            // On a wedged host, terminate that exact child handle only. Its
            // kill-on-close Job Object reaps the attached target and descendants.
            grace = setTimeout(() => {
              if (!closed) child.kill();
            }, 4000);
          };
          const timeout = setTimeout(
            () => stop('timed_out'),
            Math.max(1, deadline - Date.now()),
          );
          child.stdin.on('error', () => undefined); // EPIPE is handled by child close/result validation.
          // Always send the request before any possible cancellation control frame.
          child.stdin.write(payload + '\n', () => undefined);
          const abort = () => stop('cancelled');
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
          child.once('error', () => {
            failure = true;
          });
          child.stderr.on('data', (chunk: Buffer) => {
            // Host/compiler diagnostics are never returned, logged, or persisted.
            hostErrorBytes += chunk.length;
            if (hostErrorBytes > 32 * 1024) {
              failure = true;
              stop('cancelled');
            }
          });
          child.stdout.on('data', (chunk: Buffer) => {
            if (failure) {
              chunk.fill(0);
              return;
            }
            const prior = pending;
            pending = Buffer.concat([prior, chunk]);
            prior.fill(0);
            chunk.fill(0);
            let newline: number;
            while ((newline = pending.indexOf(10)) !== -1) {
              const line = pending.subarray(0, newline);
              pending = pending.subarray(newline + 1);
              if (line.length > 16 * 1024) {
                line.fill(0);
                failure = true;
                stop('cancelled');
                return;
              }
              try {
                const frame = JSON.parse(line.toString('utf8')) as {
                  event?: string;
                  data?: string;
                  outcome?: ProcessResult['outcome'];
                  exitCode?: number | null;
                };
                if (frame.event === 'stdout' || frame.event === 'stderr') {
                  if (
                    result ||
                    typeof frame.data !== 'string' ||
                    !/^[a-zA-Z0-9+/]*={0,2}$/.test(frame.data)
                  )
                    throw unavailable();
                  const data = Buffer.from(frame.data, 'base64');
                  if (frame.event === 'stdout' && request.stream)
                    request.stream.stdout(data);
                  const allowed = Math.max(
                    0,
                    Math.min(data.length, request.outputLimitBytes - retained),
                  );
                  (frame.event === 'stdout' ? stdout : stderr).push(
                    data.subarray(0, allowed),
                  );
                  retained += allowed;
                  if (allowed !== data.length) stop('output_limit');
                } else if (frame.event === 'result') {
                  if (
                    result ||
                    ![
                      'exited',
                      'timed_out',
                      'cancelled',
                      'output_limit',
                    ].includes(frame.outcome ?? '') ||
                    !(
                      frame.exitCode === null ||
                      Number.isInteger(frame.exitCode)
                    )
                  )
                    throw unavailable();
                  result = {
                    outcome: frame.outcome!,
                    exitCode: frame.exitCode!,
                    stdout: '',
                    stderr: '',
                  };
                } else if (frame.event === 'started') {
                  if (started) throw unavailable();
                  started = true;
                  request.stream?.started((data) => {
                    if (
                      closed ||
                      reason ||
                      typeof data !== 'string' ||
                      Buffer.byteLength(data, 'utf8') > 32 * 1024 ||
                      (inputBytes += Buffer.byteLength(data, 'utf8')) >
                        1024 * 1024
                    ) {
                      stop('output_limit');
                      return;
                    }
                    child.stdin.write(
                      'stdin ' +
                        Buffer.from(data, 'utf8').toString('base64') +
                        '\n',
                      () => undefined,
                    );
                  });
                } else throw unavailable();
              } catch {
                failure = true;
                stop('cancelled');
                return;
              } finally {
                line.fill(0);
              }
            }
            if (pending.length > 16 * 1024) {
              failure = true;
              stop('cancelled');
            }
          });
          child.once('close', (code) => {
            closed = true;
            clearTimeout(timeout);
            if (grace) clearTimeout(grace);
            request.signal.removeEventListener('abort', abort);
            child.stdin.destroy();
            const output = Buffer.concat(stdout),
              errors = Buffer.concat(stderr);
            try {
              if (
                failure ||
                (!result && !reason) ||
                (code !== 0 && !reason) ||
                pending.length !== 0
              ) {
                reject(unavailable());
                return;
              }
              resolve({
                ...(result ?? emptyResult(reason!)),
                outcome: reason ?? result!.outcome,
                stdout: output.toString('utf8'),
                stderr: errors.toString('utf8'),
              });
            } finally {
              output.fill(0);
              errors.fill(0);
              pending.fill(0);
              // DPAPI/keychain helpers use non-streamed private stdin/output.
              // Stream chunks may still belong to an asynchronous stdout writer.
              if (!request.stream) {
                for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
              }
            }
          });
        });
      } finally {
        active--;
      }
    },
  };
}
