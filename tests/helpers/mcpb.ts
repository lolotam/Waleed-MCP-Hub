import { crc32, deflateRawSync } from 'node:zlib';
import type { McpbManifest } from '@waleed/contracts';

export const bundleManifest = (): McpbManifest => ({
  manifest_version: '0.3',
  name: 'synthetic-bundle',
  version: '1.2.3',
  description: 'Synthetic inert bundle fixture',
  author: { name: 'Synthetic author' },
  server: {
    type: 'node',
    entry_point: 'server/index.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.mjs'],
      env: {
        TOKEN: '${user_config.token}',
        COUNT: '${user_config.count}',
        ENABLED: '${user_config.enabled}',
      },
    },
  },
  user_config: {
    token: {
      type: 'string',
      title: 'API token',
      description: 'Synthetic protected token',
      required: true,
      sensitive: true,
    },
    count: { type: 'number', title: 'Item count', default: 3, min: 1, max: 10 },
    enabled: { type: 'boolean', title: 'Enable feature', default: false },
  },
});
export interface ZipItem {
  name: string;
  data?: Buffer | string;
  method?: number;
  size?: number;
  attributes?: number;
  flags?: number;
  localName?: string;
}
export function zip(items: ZipItem[]) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name),
      localName = Buffer.from(item.localName ?? item.name),
      data = Buffer.from(item.data ?? ''),
      method = item.method ?? 8,
      payload = method === 0 ? data : deflateRawSync(data),
      size = item.size ?? data.length,
      checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(item.flags ?? 0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(localName.length, 26);
    local.push(header, localName, payload);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(item.flags ?? 0x800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(item.attributes ?? 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + localName.length + payload.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
export function mcpb(
  manifest: unknown = bundleManifest(),
  extra: ZipItem[] = [],
) {
  return zip([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    {
      name: 'server/index.mjs',
      data: 'throw new Error("Preview/install must never execute this fixture.");',
    },
    ...extra,
  ]);
}
