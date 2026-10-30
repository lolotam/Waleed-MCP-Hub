import { join } from 'node:path';
import { agentFiles } from '../integrations/files.js';
import {
  StoredClientTokensSchema,
  type ClientTokenStore,
} from '../http/tokens.js';
import { HubError } from '../errors.js';

// The existing runtime writer lock owns this fixed private file. It is deliberately
// outside registry/setup exports. Reuse restricted temp publication + CAS/readback.
export function localClientTokenStore(directory: string): ClientTokenStore {
  const path = join(directory, 'http-tokens.json');
  const files = agentFiles([path], join(directory, 'unused-token-backups'));
  const parse = (text: string | null) =>
    text === null
      ? { revision: 0, tokens: [] }
      : StoredClientTokensSchema.parse(JSON.parse(text));
  return {
    async read() {
      return parse(await files.read(path));
    },
    async write(expectedRevision, next) {
      const before = await files.read(path),
        current = parse(before);
      if (
        current.revision !== expectedRevision ||
        next.revision !== expectedRevision + 1
      )
        throw new HubError('conflict', 'Client tokens changed.');
      await files.replace(
        path,
        before,
        JSON.stringify(StoredClientTokensSchema.parse(next)),
      );
    },
  };
}
