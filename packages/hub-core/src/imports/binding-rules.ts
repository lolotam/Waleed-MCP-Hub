// Which credential names a connector may bind. It lives with the data-only
// import preview so the importer and the runtime enforce one rule.
import { HubError } from '../errors.js';

const forbiddenEnvironment =
  /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|PSMODULEPATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|DOCKER_.+|WMH_.+)$/i;
export function assertBinding(
  location: 'environment' | 'header',
  name: string,
  format: string,
) {
  if (location === 'environment') {
    if (
      !/^[A-Z_][A-Z0-9_]{0,99}$/.test(name) ||
      forbiddenEnvironment.test(name) ||
      format !== 'raw'
    )
      throw new HubError(
        'invalid',
        'Only non-runtime credential environment bindings are supported.',
      );
  } else if (
    !/^(?:Authorization|X-[A-Za-z0-9-]+|Api-Key)$/i.test(name) ||
    /^(?:x-forwarded-|x-csrf-|x-mcp-)/i.test(name)
  )
    throw new HubError(
      'invalid',
      'Choose a supported credential header, not transport/session headers.',
    );
}
