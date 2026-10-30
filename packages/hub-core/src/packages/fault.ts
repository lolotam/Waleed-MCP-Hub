import type { PackageErrorCode } from '@waleed/contracts';

// A package failure carries its code and nothing else: no path, no package
// text and no registry response ever reaches the message.
export class PackageFault extends Error {
  constructor(readonly code: PackageErrorCode) {
    super('Package operation failed.');
  }
}
