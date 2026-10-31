import { afterEach, describe, expect, it } from 'vitest';
import {
  createLifecycle,
  createMemorySafetyLedger,
  definitionHash,
} from '@waleed/hub-core';
import { memoryStore } from './helpers/memory-store.js';
import { profileState } from './helpers/runtime.js';
import { memorySecrets } from './helpers/secrets.js';

// A pooled peer keeps the value it resolved at its start and is revalidated
// against the definition hash and the credential stamp of its connector. The
// stamp carries no value, so every value write must change the definition:
// a rotated or replaced value is a new immutable reference, never a new
// value under the old one.
const memories: ReturnType<typeof memorySecrets>[] = [];
afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
});

describe('credential rotation and the pooled peers', () => {
  it('a value written again under the same binding is a new reference and a new definition', async () => {
    const store = memoryStore(profileState(['remote']));
    const secrets = memorySecrets();
    memories.push(secrets);
    const written: string[] = [];
    const put = secrets.backend.put.bind(secrets.backend);
    secrets.backend.put = async (id, value, signal) => {
      written.push(id);
      await put(id, value, signal);
    };
    const hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
      secrets: { windows: secrets.backend },
    });
    try {
      const write = async (value: string) => {
        const state = await hub.inventory();
        const connector = state.connectors[0]!;
        await hub.auth.credentials.write(connector.id, {
          expectedRevision: state.revision,
          expectedConnectorRevision: connector.revision,
          location: 'header',
          name: 'Authorization',
          format: 'bearer',
          adapter: 'windows',
          value,
        });
        const after = (await hub.inventory()).connectors[0]!;
        return {
          id: after.headerBindings.Authorization,
          hash: definitionHash(after),
        };
      };
      const first = await write('test-value-a');
      const second = await write('test-value-b');
      expect(second.id).not.toBe(first.id);
      expect(second.hash).not.toBe(first.hash);
      // No value was ever written under a reference that already existed.
      expect(new Set(written).size).toBe(written.length);
    } finally {
      await hub.close();
    }
  });
});
