import type {
  HubState,
  ToolOverride,
  CapabilityObservation,
} from '@waleed/contracts';
import { ToolOverrideSchema } from '@waleed/contracts';
import { hashData, definitionHash } from '../runtime/registry.js';
import { bridgeToolName } from './tool-names.js';
import { HubError } from '../errors.js';

export function findToolOverride(
  state: HubState,
  connectorId: string,
  name: string,
): ToolOverride | undefined {
  const raw = state.toolOverrides?.find(
    (item) =>
      item.connectorId === connectorId && item.originalToolName === name,
  );
  return raw === undefined ? undefined : ToolOverrideSchema.parse(raw);
}
export const toolOverrideHash = (
  state: HubState,
  connectorId: string,
  name: string,
) => hashData(findToolOverride(state, connectorId, name) ?? null);
// Registry validation cannot discover or start providers. Validate all known
// names now, then fail closed against newly discovered metadata in the bridge.
export function assertToolOverrideCollisions(
  state: HubState,
  observations: CapabilityObservation[] = [],
) {
  const taken = new Set<string>(),
    known: Array<{ connectorId: string; name: string; canonical: string }> = [];
  for (const connector of state.connectors) {
    const observed = observations.find(
      (item) =>
        item.connectorId === connector.id &&
        item.revision === connector.revision &&
        item.definitionHash === definitionHash(connector),
    );
    const names = new Set([
      ...(observed?.tools.map((tool) => tool.name) ?? []),
      ...Object.keys(connector.toolPolicies ?? {}),
      ...(state.toolOverrides ?? [])
        .filter((item) => item.connectorId === connector.id)
        .map((item) => item.originalToolName),
    ]);
    for (const name of names) {
      const canonical = bridgeToolName(connector, name, taken);
      taken.add(canonical);
      known.push({ connectorId: connector.id, name, canonical });
    }
  }
  for (const override of state.toolOverrides ?? []) {
    if (!override.alias) continue;
    if (
      known.some(
        (tool) =>
          (tool.connectorId !== override.connectorId ||
            tool.name !== override.originalToolName) &&
          (tool.canonical === override.alias || tool.name === override.alias),
      )
    )
      throw new HubError(
        'conflict',
        'Tool alias conflicts with another known tool. Refresh and choose a unique alias.',
      );
  }
}
