export class HubError extends Error {
  constructor(
    public readonly code:
      'conflict' | 'unavailable' | 'invalid' | 'not_found' | 'busy',
    message: string,
  ) {
    super(message);
  }
}

// A revision mismatch: the inventory moved between the preview and the apply.
// Nothing was committed, so the caller may run the operation again.
export class RevisionConflictError extends HubError {
  constructor(message: string) {
    super('conflict', message);
  }
}

// The revision mismatch is recognisable without reading the message text: a
// name conflict and every other conflict stay what they are.
export const isRevisionConflict = (error: unknown): boolean =>
  error instanceof RevisionConflictError;
