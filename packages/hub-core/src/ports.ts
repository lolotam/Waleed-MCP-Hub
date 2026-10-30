// Internal adapter seams only. No HTTP endpoint accepts a ProcessRequest, and no
// generic process runner or secret-value read interface is exposed over HTTP.
export interface ProcessRequest {
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs: number;
  outputLimitBytes: number;
  signal: AbortSignal;
  // Internal bridge-only duplex sessions retain containment and a one-hour cap.
  session?: boolean;
  // Internal duplex seam used by the contained stdio transport/launcher only.
  // Control frames remain separate from target stdin; callbacks are never HTTP input.
  stream?: {
    started(write: (data: string) => void, endInput?: () => void): void;
    // Synchronously consume or copy: the runner zeros this buffer on return.
    stdout(data: Buffer): void;
  };
}
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outcome: 'exited' | 'timed_out' | 'cancelled' | 'output_limit';
}
export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}
export interface ProcessRunnerOptions {
  allowedExecutables: readonly string[];
  workingDirectory: string;
  concurrency?: number;
}
// P1 synthetic harness seam. P6 production adapters use the mutable Buffer-based
// SecretBackend/lease seam in auth/secrets.ts; HTTP sees references/presence only.
export interface SecretStore {
  put(id: string, value: string): Promise<void>;
  has(id: string): Promise<boolean>;
  resolve(id: string): Promise<string>;
  delete(id: string): Promise<void>;
}
