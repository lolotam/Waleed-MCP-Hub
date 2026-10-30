import { createHash } from 'node:crypto';
export function bridgeToolName(
  connector: { id: string; name: string },
  tool: string,
  taken: ReadonlySet<string>,
) {
  const slug = (value: string) =>
    value
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '');
  const name = `${slug(connector.name).toLowerCase() || 'connector'}__${slug(tool) || 'tool'}`;
  if (name.length <= 40 && !taken.has(name)) return name;
  const suffix = `_${createHash('sha256')
    .update(JSON.stringify([connector.id, tool]))
    .digest('hex')
    .slice(0, 6)}`;
  return `${name.slice(0, 40 - suffix.length).replace(/[_-]+$/, '')}${suffix}`;
}
