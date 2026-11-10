import { HubError } from '../errors.js';
import {
  MAX_REQUEST_BYTES,
  type Connector,
  type ConnectorExport,
} from '@waleed/contracts';

// The hub export format: a versioned document of connectors without any
// secret, approval, observation, install path or profile.
export const HUB_EXPORT_FORMAT = 'waleed-mcp-hub/connectors';
export const HUB_EXPORT_VERSION = 1;
// A part holds at most the 32 entries an import accepts and stays under the
// 40 KiB that leaves room under the 48 KiB source limit of the importer.
const MAX_PART_CONNECTORS = 32;
const MAX_PART_BYTES = 40 * 1024;

type CredentialFormat = 'raw' | 'bearer' | 'basic';

interface HubPackage {
  name: string;
  version: string;
  entry: string;
  arguments: string[];
}

interface HubConnector {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  executionMode: 'remote' | 'native' | 'docker' | 'package';
  transport?: string;
  endpoint?: string;
  executable?: string;
  arguments?: string[];
  image?: string;
  command?: string[];
  portBindings?: { host: number; container: number }[];
  package?: HubPackage;
  environmentLiterals?: Record<string, string>;
  environmentCredentials?: string[];
  headerCredentials?: { name: string; format: CredentialFormat }[];
}

type SkippedConnector = ConnectorExport['skipped'][number];

const document = (connectors: HubConnector[], part: number, parts: number) => ({
  format: HUB_EXPORT_FORMAT,
  version: HUB_EXPORT_VERSION,
  part,
  parts,
  connectors,
});

const partText = (connectors: HubConnector[], part: number, parts: number) =>
  JSON.stringify(document(connectors, part, parts), null, 2);

const partBytes = (connectors: HubConnector[], part: number, parts: number) =>
  Buffer.byteLength(partText(connectors, part, parts), 'utf8');

const requestBytes = (
  connectors: HubConnector[],
  part: number,
  parts: number,
) =>
  Buffer.byteLength(
    JSON.stringify({
      source: partText(connectors, part, parts),
      // The preview sends the current revision; measure the widest one.
      expectedRevision: Number.MAX_SAFE_INTEGER,
    }),
    'utf8',
  );

// A part the importer can read: at most 32 entries, at most 40 KiB of text
// and at most 64 KiB of request body.
const fits = (
  connectors: HubConnector[],
  part: number,
  parts: number,
): boolean =>
  partBytes(connectors, part, parts) <= MAX_PART_BYTES &&
  requestBytes(connectors, part, parts) <= MAX_REQUEST_BYTES;

const credentialFormat = (
  connector: Connector,
  name: string,
): CredentialFormat => connector.credentialFormats?.[name] ?? 'raw';

// The managed package connector keeps its package record and its user
// arguments. The install path and the hub runtime never leave the machine.
const packageConnector = (
  connector: Extract<Connector, { executionMode: 'native' }>,
): HubConnector => {
  const provenance = connector.package!;
  if (provenance.source)
    throw new HubError(
      'invalid',
      'This export format cannot preserve GitHub artifact provenance.',
    );
  return {
    id: connector.id,
    name: connector.name,
    description: connector.description,
    enabled: connector.enabled,
    executionMode: 'package',
    package: {
      name: provenance.name,
      version: provenance.version,
      entry: provenance.entry,
      // The stored arguments are the runtime flag, the entry file and the
      // user arguments; only the user arguments travel.
      arguments: connector.arguments.slice(2),
    },
    environmentLiterals: { ...(connector.environmentLiterals ?? {}) },
    environmentCredentials: Object.keys(connector.secretBindings),
  };
};

const hubConnector = (connector: Connector): HubConnector => {
  const base = {
    id: connector.id,
    name: connector.name,
    description: connector.description,
    enabled: connector.enabled,
  };
  if (connector.executionMode === 'remote')
    return {
      ...base,
      executionMode: 'remote',
      transport: connector.transport,
      endpoint: connector.endpoint,
      headerCredentials: Object.keys(connector.headerBindings).map((name) => ({
        name,
        format: credentialFormat(connector, name),
      })),
    };
  if (connector.executionMode === 'docker')
    return {
      ...base,
      executionMode: 'docker',
      image: connector.image,
      command: connector.command ?? [],
      arguments: connector.arguments,
      ...(connector.portBindings?.length
        ? { portBindings: connector.portBindings }
        : {}),
      environmentLiterals: { ...(connector.environmentLiterals ?? {}) },
      environmentCredentials: Object.keys(connector.secretBindings),
    };
  if (connector.package) return packageConnector(connector);
  return {
    ...base,
    executionMode: 'native',
    executable: connector.executable,
    arguments: connector.arguments,
    environmentLiterals: { ...(connector.environmentLiterals ?? {}) },
    environmentCredentials: Object.keys(connector.secretBindings),
  };
};
// The greedy packing in registry order: a part closes when the next
// connector would exceed the entry count or the byte budget of a part.
const packGroups = (
  connectors: HubConnector[],
): { groups: HubConnector[][]; skipped: SkippedConnector[] } => {
  const groups: HubConnector[][] = [];
  const skipped: SkippedConnector[] = [];
  let current: HubConnector[] = [];
  for (const connector of connectors) {
    if (
      current.length >= MAX_PART_CONNECTORS ||
      !fits([...current, connector], 1, 1)
    ) {
      if (current.length) groups.push(current);
      current = [];
      if (!fits([connector], 1, 1)) {
        skipped.push({
          id: connector.id,
          name: connector.name,
          reason: 'too_large',
        });
        continue;
      }
    }
    current.push(connector);
  }
  if (current.length) groups.push(current);
  return { groups, skipped };
};

// The part and parts numbers are written after the packing, so every part is
// measured again with its own numbers. A part that is still too large gives
// its last connector to a part of its own; a connector that fits in no part at
// all is skipped.
const numberParts = (
  groups: HubConnector[][],
  skipped: SkippedConnector[],
): HubConnector[][] => {
  let parts = groups;
  for (;;) {
    const total = parts.length;
    const over = parts.findIndex(
      (group, index) => !fits(group, index + 1, total),
    );
    if (over < 0) return parts;
    const group = parts[over]!;
    const moved = group[group.length - 1]!;
    const kept = group.slice(0, -1);
    const rest = parts.slice(over + 1);
    const skipMoved = (): void => {
      skipped.push({ id: moved.id, name: moved.name, reason: 'too_large' });
    };
    if (!kept.length) {
      skipMoved();
      parts = [...parts.slice(0, over), ...rest];
      continue;
    }
    if (!fits([moved], over + 2, total + 1)) {
      skipMoved();
      parts = [...parts.slice(0, over), kept, ...rest];
      continue;
    }
    parts = [...parts.slice(0, over), kept, [moved], ...rest];
  }
};

// The export of a registry: the serialized part files and the connectors that
// no part can carry. The registry state is the only input; no credential
// store is read.
export function exportConnectors(
  connectors: readonly Connector[],
): ConnectorExport {
  const hubConnectors = connectors.map(hubConnector);
  const { groups, skipped } = packGroups(hubConnectors);
  const parts = numberParts(groups, skipped);
  const order = new Map(
    hubConnectors.map((connector, index) => [connector.id, index]),
  );
  skipped.sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
  return {
    parts: parts.map((group, index) =>
      partText(group, index + 1, parts.length),
    ),
    skipped,
  };
}
