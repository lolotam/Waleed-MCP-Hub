import { z } from 'zod';
import { IntegrationAgentIdSchema } from './integrations.js';

export const HttpClientAgentIdSchema = z.union([
  IntegrationAgentIdSchema,
  z.literal('http-client'),
]);
export type HttpClientAgentId = z.infer<typeof HttpClientAgentIdSchema>;
const profileId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ClientTokenSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().trim().min(1).max(64),
  agentId: HttpClientAgentIdSchema.optional(),
  profileId: profileId.optional(),
  tokenPreview: z.string().regex(/^wmh_live_\.\.\.[a-f0-9]{4}$/),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime().optional(),
});
export type ClientToken = z.infer<typeof ClientTokenSchema>;
export const CreateClientTokenRequestSchema = z.strictObject({
  expectedRevision: revision,
  label: z.string().trim().min(1).max(64),
  agentId: HttpClientAgentIdSchema.optional(),
  profileId: profileId.optional(),
  expiresAt: z.iso.datetime().optional(),
});
export const ClientTokensListSchema = z.strictObject({
  revision,
  tokens: z.array(ClientTokenSchema).max(256),
});
export const ClientTokenSecretSchema = z
  .string()
  .regex(/^wmh_live_[a-f0-9]{64}$/);
export const CreatedClientTokenSchema = z.strictObject({
  revision,
  token: ClientTokenSchema,
  plaintextToken: ClientTokenSecretSchema,
});
export const RevokeClientTokenRequestSchema = z.strictObject({
  expectedRevision: revision,
});
export const McpSessionIdSchema = z.uuid();
// Normalized HTTP header names; cookies and URL query parameters are not credentials.
export const StreamableHttpHeadersSchema = z.object({
  authorization: z.string().regex(/^Bearer wmh_live_[a-f0-9]{64}$/),
  'mcp-session-id': McpSessionIdSchema.optional(),
  'mcp-protocol-version': z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export const StreamableHttpTransportSchema = z.strictObject({
  type: z.literal('streamable-http'),
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname === '/mcp' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
});
