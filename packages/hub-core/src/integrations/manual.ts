import { randomUUID } from 'node:crypto';
import {
  ManualMcpSchema,
  type HubState,
  type ImportDefinition,
  type RegistryOperation,
} from '@waleed/contracts';
import type { HubLifecycle } from '../lifecycle.js';
import { HubError } from '../errors.js';
import { definitionHash } from '../runtime/registry.js';
import { assertBinding } from '../auth/bindings.js';
import { assertNoCredentialEcho } from './bridge.js';

// The shared credential write: every value is written through the journaled
// one-way interface of P6, one at a time, with the state read again before
// each write. The value is blanked as soon as it is stored, so it never stays
// in the caller's map.
export async function writeCredentialValues(
  host: {
    inventory(): Promise<HubState>;
    auth: {
      credentials: {
        write(connectorId: string, raw: unknown): Promise<unknown>;
      };
    };
  },
  connectorId: string,
  location: 'environment' | 'header',
  values: Record<string, string>,
  adapter: 'windows' | 'docker',
): Promise<void> {
  for (const name of Object.keys(values)) {
    const state = await host.inventory(),
      connector = state.connectors.find((item) => item.id === connectorId)!;
    await host.auth.credentials.write(connectorId, {
      expectedRevision: state.revision,
      expectedConnectorRevision: connector.revision,
      location,
      name,
      format: 'raw',
      adapter,
      value: values[name],
    });
    values[name] = '';
  }
}

// Values are transient and committed through P6's journaled one-way interface.
// Partial completion is explicit; never retry a saved definition as a new one.
export async function addManualMcp(
  hub: HubLifecycle,
  raw: unknown,
  owner: string,
) {
  let input: ReturnType<typeof ManualMcpSchema.parse> | undefined;
  const clear = () => {
    for (const source of [raw, input])
      if (source && typeof source === 'object')
        for (const field of ['env', 'headers']) {
          const map = (source as Record<string, unknown>)[field];
          if (map && typeof map === 'object')
            for (const key of Object.keys(map))
              // Only the value of an own key is cleared, defined in place:
              // a key such as __proto__ can never reach the prototype.
              Object.defineProperty(map, key, {
                value: '',
                writable: true,
                enumerable: true,
                configurable: true,
              });
        }
  };
  let saved = false;
  const id = `manual-${randomUUID()}`;
  try {
    input = ManualMcpSchema.parse(raw);
    if (
      (input.type !== 'docker' && input.ports.length) ||
      (input.type === 'stdio' && Object.keys(input.headers).length) ||
      (input.type === 'docker' && Object.keys(input.headers).length) ||
      (!['stdio', 'docker'].includes(input.type) &&
        Object.keys(input.env).length)
    )
      throw new HubError(
        'invalid',
        'Credential location or ports do not match the selected runtime.',
      );
    if (Object.keys(input.env).length + Object.keys(input.headers).length > 16)
      throw new HubError(
        'invalid',
        'At most 16 credential bindings can be saved at once.',
      );
    for (const key of Object.keys(input.env))
      assertBinding('environment', key, 'raw');
    for (const key of Object.keys(input.headers))
      assertBinding('header', key, 'raw');
    const common = {
      id,
      name: input.name,
      description: 'Manually configured MCP',
      enabled: true,
      environmentLiterals: {},
      secretBindings: {},
      headerBindings: {},
      trustApproval: null,
    };
    const definition: ImportDefinition =
      input.type === 'stdio'
        ? {
            ...common,
            executionMode: 'native',
            transport: 'stdio',
            executable: input.command,
            arguments: input.args,
          }
        : input.type === 'docker'
          ? {
              ...common,
              executionMode: 'docker',
              transport: 'stdio',
              image: input.image,
              command: [],
              arguments: input.args,
              portBindings: input.ports,
            }
          : {
              ...common,
              executionMode: 'remote',
              transport: input.type,
              endpoint: input.url,
            };
    try {
      assertNoCredentialEcho(definition, [
        ...Object.values(input.env),
        ...Object.values(input.headers),
      ]);
    } catch {
      throw new HubError(
        'invalid',
        'Credential values cannot appear in public names, commands, arguments or URLs.',
      );
    }
    const apply = async (operation: RegistryOperation) => {
      const preview = await hub.preview(operation, owner);
      const job = await hub.apply(preview.id, owner);
      await hub.drain();
      if (hub.job(job.id, owner).state !== 'succeeded')
        throw new HubError(
          'unavailable',
          'Manual definition operation failed.',
        );
    };
    await apply({
      kind: 'create_connector',
      expectedRevision: input.expectedRevision,
      definition,
    });
    saved = true;
    for (const location of ['environment', 'header'] as const) {
      const values = location === 'environment' ? input.env : input.headers;
      await writeCredentialValues(
        hub,
        id,
        location,
        values,
        input.type === 'docker' ? 'docker' : 'windows',
      );
    }
    if (input.approveExecution) {
      const state = await hub.inventory(),
        connector = state.connectors.find((item) => item.id === id)!;
      await apply({
        kind: 'approve_connector',
        expectedRevision: state.revision,
        connectorId: id,
        expectedConnectorRevision: connector.revision,
        definitionHash: definitionHash(connector),
        approveExecution: true,
      });
    }
    const sync = input.autoSync ? await hub.integrations.sync() : null;
    return {
      connectorId: id,
      state: 'saved' as const,
      requiresApproval: !input.approveExecution,
      authenticationVerified: false,
      sync,
    };
  } catch (error) {
    if (saved)
      return {
        connectorId: id,
        state: 'partially_saved' as const,
        requiresApproval: true,
        authenticationVerified: false,
        sync: null,
        message:
          'Definition saved. Credential, approval or synchronization did not complete. Inspect this connector and recovery; do not add it again.',
      };
    throw error;
  } finally {
    clear();
  }
}
