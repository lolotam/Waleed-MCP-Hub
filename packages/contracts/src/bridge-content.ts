import { z } from 'zod';

// Wire payloads use the MCP SDK Resource/ResourceTemplate/Prompt schemas in
// hub-core. Keep the shared advertised capability contract browser-safe.
export const ManagedBridgeCapabilitiesSchema = z.strictObject({
  tools: z.strictObject({ listChanged: z.literal(true) }),
  resources: z.strictObject({
    subscribe: z.literal(false),
    listChanged: z.literal(true),
  }),
  prompts: z.strictObject({ listChanged: z.literal(true) }),
});
export const MANAGED_BRIDGE_CAPABILITIES =
  ManagedBridgeCapabilitiesSchema.parse({
    tools: { listChanged: true },
    resources: { subscribe: false, listChanged: true },
    prompts: { listChanged: true },
  });
