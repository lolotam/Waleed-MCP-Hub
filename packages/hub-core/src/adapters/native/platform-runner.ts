import { createWindowsProcessRunner } from './process-runner.js';
import type { ProcessRunnerOptions } from '../../ports.js';
import { createPosixProcessRunner } from './posix-runner.js';
import { supportedPlatform } from '../../platform/paths.js';

// The Windows branch remains the exact JobObject implementation. POSIX has a
// separate adapter; failure never falls through to an ordinary child spawn.
export function createPlatformProcessRunner(options: ProcessRunnerOptions) {
  return supportedPlatform(process.platform) === 'win32'
    ? createWindowsProcessRunner(options)
    : createPosixProcessRunner(options);
}
