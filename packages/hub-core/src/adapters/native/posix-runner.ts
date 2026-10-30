import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  ProcessRunnerOptions,
} from '../../ports.js';
import { HubError } from '../../errors.js';

const invalid = () =>
  new HubError(
    'invalid',
    'Use approved absolute POSIX executables and bounded explicit arguments/environment.',
  );
const unavailable = () =>
  new HubError(
    'unavailable',
    'The owned POSIX process group could not be started or terminated.',
  );
const absolute = (path: string) =>
  posix.isAbsolute(path) && !/[\0\r\n\\]/.test(path);
const empty = (outcome: ProcessResult['outcome']): ProcessResult => ({
  outcome,
  exitCode: null,
  stdout: '',
  stderr: '',
});
function validate(request: ProcessRequest) {
  if (
    !absolute(request.executable) ||
    (request.session && !request.stream) ||
    (request.stream &&
      (request.stdin !== undefined ||
        typeof request.stream.started !== 'function' ||
        typeof request.stream.stdout !== 'function')) ||
    (request.stdin !== undefined &&
      (typeof request.stdin !== 'string' ||
        Buffer.byteLength(request.stdin) > 32 * 1024)) ||
    !Array.isArray(request.arguments) ||
    request.arguments.length > 128 ||
    request.arguments.some(
      (arg) =>
        typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'),
    ) ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 50 ||
    request.timeoutMs > (request.session ? 3_600_000 : 120_000) ||
    !Number.isInteger(request.outputLimitBytes) ||
    request.outputLimitBytes < 1 ||
    request.outputLimitBytes > 1024 * 1024 ||
    Object.entries(request.environment).length > 64 ||
    Object.entries(request.environment).some(
      ([key, value]) =>
        !/^[a-z_][a-z0-9_]*$/i.test(key) ||
        typeof value !== 'string' ||
        value.length > 8192 ||
        value.includes('\0'),
    )
  )
    throw invalid();
}
export async function createPosixProcessRunner(
  options: ProcessRunnerOptions,
): Promise<ProcessRunner> {
  if (!['darwin', 'linux'].includes(process.platform)) throw unavailable();
  const concurrency = options.concurrency ?? 2;
  if (
    !absolute(options.workingDirectory) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !options.allowedExecutables.length ||
    options.allowedExecutables.length > 16
  )
    throw invalid();
  const directory = await realpath(options.workingDirectory);
  if (!(await stat(directory)).isDirectory()) throw invalid();
  const approved = new Set<string>();
  for (const executable of options.allowedExecutables) {
    if (!absolute(executable)) throw invalid();
    const canonical = await realpath(executable);
    if (!absolute(canonical) || !(await stat(canonical)).isFile())
      throw invalid();
    approved.add(canonical);
  }
  let active = 0;
  return {
    async run(request) {
      validate(request);
      request = {
        ...request,
        arguments: [...request.arguments],
        environment: { ...request.environment },
      };
      if (request.signal.aborted) return empty('cancelled');
      const executable = await realpath(request.executable);
      if (!approved.has(executable)) throw invalid();
      if (request.signal.aborted) return empty('cancelled');
      if (active >= concurrency)
        throw new HubError(
          'busy',
          'The bounded process concurrency limit has been reached.',
        );
      active++;
      try {
        return await new Promise<ProcessResult>((resolve, reject) => {
          // No shell, inherited environment, or uncontained spawn fallback. A new
          // process group permits cleanup of ordinary descendants, not a sandbox.
          const child = spawn(executable, [...request.arguments], {
            cwd: directory,
            env: { ...request.environment },
            shell: false,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const stdout: Buffer[] = [],
            stderr: Buffer[] = [];
          let bytes = 0,
            input = 0,
            reason: ProcessResult['outcome'] | undefined,
            failure = false,
            finished = false,
            groupTerminated = false;
          let grace: ReturnType<typeof setTimeout> | undefined;
          let drain: ReturnType<typeof setTimeout> | undefined;
          // Once killed/absent, never signal this numeric group again: its ID
          // could be reused while inherited pipes are still closing.
          const killGroup = (signal: NodeJS.Signals) => {
            if (!child.pid || groupTerminated) return;
            try {
              process.kill(-child.pid, signal);
              if (signal === 'SIGKILL') groupTerminated = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH')
                groupTerminated = true;
              else failure = true;
            }
          };
          const closePipes = () => {
            if (
              !reason &&
              (!child.stdout.readableEnded || !child.stderr.readableEnded)
            )
              failure = true;
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
          };
          const stop = (outcome: ProcessResult['outcome']) => {
            if (finished || reason) return;
            reason = outcome;
            killGroup('SIGTERM');
            grace = setTimeout(() => {
              killGroup('SIGKILL');
              closePipes();
            }, 200);
            grace.unref();
          };
          const abort = () => stop('cancelled');
          const onExit = () => killGroup('SIGKILL');
          const timer = setTimeout(() => stop('timed_out'), request.timeoutMs);
          timer.unref();
          request.signal.addEventListener('abort', abort, { once: true });
          process.once('exit', onExit);
          const consume = (chunk: Buffer, errorOutput: boolean) => {
            try {
              if ((bytes += chunk.length) > request.outputLimitBytes) {
                stop('output_limit');
                return;
              }
              if (errorOutput) stderr.push(Buffer.from(chunk));
              else if (request.stream) request.stream.stdout(chunk);
              else stdout.push(Buffer.from(chunk));
            } catch {
              failure = true;
              stop('cancelled');
            } finally {
              chunk.fill(0);
            }
          };
          child.stdout.on('data', (chunk: Buffer) => consume(chunk, false));
          child.stderr.on('data', (chunk: Buffer) => consume(chunk, true));
          child.stdin.on('error', () => {
            if (!finished && !reason) {
              failure = true;
              stop('cancelled');
            }
          });
          child.once('error', () => {
            failure = true;
          });
          child.once('exit', () => {
            killGroup('SIGKILL');
            // An escaped descendant may hold inherited pipes open. Bound drain
            // time and fail instead of claiming complete output from that tree.
            drain = setTimeout(closePipes, 200);
            drain.unref();
          });
          child.once('close', (code) => {
            finished = true;
            clearTimeout(timer);
            clearTimeout(grace);
            clearTimeout(drain);
            request.signal.removeEventListener('abort', abort);
            process.off('exit', onExit);
            killGroup('SIGKILL');
            const output = Buffer.concat(stdout),
              errors = Buffer.concat(stderr);
            try {
              if (failure) reject(unavailable());
              else
                resolve({
                  exitCode: code,
                  outcome: reason ?? 'exited',
                  stdout: output.toString('utf8'),
                  stderr: errors.toString('utf8'),
                });
            } finally {
              output.fill(0);
              errors.fill(0);
              stdout.forEach((chunk) => chunk.fill(0));
              stderr.forEach((chunk) => chunk.fill(0));
            }
          });
          child.once('spawn', () => {
            if (request.signal.aborted) {
              stop('cancelled');
              return;
            }
            try {
              if (request.stream)
                request.stream.started(
                  (data) => {
                    if (finished || reason) return;
                    if (
                      typeof data !== 'string' ||
                      (input += Buffer.byteLength(data)) > 1024 * 1024
                    ) {
                      stop('output_limit');
                      return;
                    }
                    const chunk = Buffer.from(data);
                    child.stdin.write(chunk, () => chunk.fill(0));
                  },
                  () => child.stdin.end(),
                );
              else child.stdin.end(request.stdin ?? '');
            } catch {
              failure = true;
              stop('cancelled');
            }
          });
        });
      } finally {
        active--;
      }
    },
  };
}
