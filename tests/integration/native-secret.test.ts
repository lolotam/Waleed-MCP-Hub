import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  windowsSecretStore,
  createCapabilityRuntime,
  createBindingResolver,
  createLifecycle,
  createMemorySafetyLedger,
  definitionHash,
} from '@waleed/hub-core';
import { profileState, apply } from '../helpers/runtime.js';
import { memoryStore } from '../helpers/memory-store.js';

describe.skipIf(process.platform !== 'win32')(
  'disposable real DPAPI-backed native connector',
  () => {
    it('stores and resolves only the declared credential, discovers over contained stdio and clears the owned value', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hub-secret-native-'));
      let hub: ReturnType<typeof createLifecycle> | undefined;
      try {
        const backend = await windowsSecretStore(
          join(directory, 'credentials'),
        );
        const state = profileState(['native']);
        const connector = state.connectors[0]!;
        if (connector.executionMode !== 'native') throw new Error();
        connector.executable = process.execPath;
        connector.arguments = [
          fileURLToPath(new URL('../fixtures/mcp-secret.mjs', import.meta.url)),
          join(directory, 'evidence.json'),
        ];
        connector.trustApproval!.definitionHash = definitionHash(connector);
        const store = memoryStore(state);
        const runtime = createCapabilityRuntime({
          workingDirectory: directory,
          resolveBindings: createBindingResolver({ windows: backend }, () =>
            store.read(),
          ),
        });
        hub = createLifecycle(store, Date.now, createMemorySafetyLedger(), {
          secrets: { windows: backend },
          runtime,
        });
        const value = 'SYNTHETIC_NATIVE_DPAPI_0123456789';
        const receipt = await hub.auth.credentials.write(connector.id, {
          expectedRevision: 0,
          expectedConnectorRevision: 1,
          location: 'environment',
          name: 'PROVIDER_TOKEN',
          format: 'raw',
          adapter: 'windows',
          value,
        });
        const current = (await hub.inventory()).connectors[0]!;
        expect(
          (
            await apply(hub, {
              kind: 'approve_connector',
              connectorId: current.id,
              expectedConnectorRevision: current.revision,
              definitionHash: definitionHash(current),
              approveExecution: true,
            })
          ).state,
        ).toBe('succeeded');
        const check = await hub.checks.start(current.id, 'owner');
        await hub.checks.drain();
        expect(hub.checks.job(check.id, 'owner').state).toBe('succeeded');
        const evidence = JSON.parse(
          await readFile(join(directory, 'evidence.json'), 'utf8'),
        ) as { accepted: boolean; methods: string[] };
        expect(evidence.accepted).toBe(true);
        expect(evidence.methods).not.toContain('tools/call');
        expect(
          JSON.stringify([
            receipt,
            await hub.inventory(),
            await hub.checks.observations(),
            evidence,
          ]),
        ).not.toContain(value);
        await apply(hub, { kind: 'remove_connector', connectorId: current.id });
        await hub.auth.credentials.delete(
          receipt.id,
          (await hub.inventory()).revision,
        );
        expect(await backend.has(receipt.id, AbortSignal.timeout(1000))).toBe(
          false,
        );
      } finally {
        await hub?.close();
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 100,
        });
      }
    }, 40_000);
  },
);
