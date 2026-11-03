import {
  DefaultToolPolicySchema,
  ToolPolicyNameSchema,
  ToolPolicySchema,
  type Connector,
} from '@waleed/contracts';

// Listing and dispatch must use the same rule, including malformed input.
export function toolPolicy(connector: Connector, name: string) {
  if (!ToolPolicyNameSchema.safeParse(name).success) return 'block';
  if (Object.hasOwn(connector.toolPolicies ?? {}, name)) {
    const policy = ToolPolicySchema.safeParse(connector.toolPolicies![name]);
    return policy.success ? policy.data : 'block';
  }
  const fallback = DefaultToolPolicySchema.safeParse(
    connector.defaultToolPolicy === undefined ? 'allow' : connector.defaultToolPolicy,
  );
  return fallback.success ? fallback.data : 'block';
}

// A direct export cannot enforce either a per-tool rule or default-block.
export const hasRestrictedTools = (connector: Connector) =>
  (connector.defaultToolPolicy !== undefined && connector.defaultToolPolicy !== 'allow') ||
  Object.values(connector.toolPolicies ?? {}).some((policy) => policy !== 'allow');
