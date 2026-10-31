import { z } from 'zod';
import { IntegrationAgentIdSchema } from './integrations.js';

const LowerUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'A lower-case UUID is required.',
  );
const ContainerId = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'An immutable container id is required.');

// The ownership marker of one container session. It names the installation,
// the agent, the bridge and the session nonce, the daemon that owns the
// container and the phase the session reached. A marker that does not parse
// is uncertain cleanup: it is kept and it blocks its agent.
//
// A `running` or a `removing` marker names the immutable container id: the
// recovery confirms that id is absent, so a marker without one would never
// be resolved and would block its agent for good.
export const DockerMarkerSchema = z
  .strictObject({
    nonce: LowerUuid,
    connectorId: z
      .string()
      .max(80)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    agentId: IntegrationAgentIdSchema,
    bridgeId: LowerUuid,
    dockerEndpoint: z.string().max(512),
    daemonId: z.string().max(128),
    phase: z.enum(['launching', 'running', 'removing']),
    containerId: ContainerId.optional(),
  })
  .superRefine((marker, ctx) => {
    if (marker.phase !== 'launching' && !marker.containerId)
      ctx.addIssue({
        code: 'custom',
        message:
          'A running or removing marker names the immutable container id.',
      });
  });
export type DockerMarker = z.infer<typeof DockerMarkerSchema>;
export type DockerMarkerPhase = DockerMarker['phase'];
