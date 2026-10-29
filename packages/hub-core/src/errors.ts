export class HubError extends Error {
  constructor(
    public readonly code:
      'conflict' | 'unavailable' | 'invalid' | 'not_found' | 'busy',
    message: string,
  ) {
    super(message);
  }
}
