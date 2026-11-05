import { describe, expect, it } from 'vitest';
import type { CapabilityObservation } from '@waleed/contracts';
import type { ManagedConnector } from '../apps/web/src/ConnectorList.js';
import { discoveryProgress } from '../apps/web/src/discovery-progress.js';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);

// The observations that say nothing about the current definition of a
// connector: they belong to a revision or a hash that is gone.
const staleObservations: Array<{
  label: string;
  options: { revision?: number; hash?: string };
}> = [
  { label: 'an older revision', options: { revision: 0 } },
  { label: 'another definition hash', options: { hash: otherHash } },
];
// The observation states that mean the discovery of the connector is not
// finished yet.
const unfinishedStates = ['untested', 'checking'] as const;

function connectorFixture(
  options: {
    id?: string;
    enabled?: boolean;
    revision?: number;
    approved?: boolean;
    approvedRevision?: number;
    approvedHash?: string;
    hash?: string;
  } = {},
): ManagedConnector {
  const id = options.id ?? 'fixture';
  const revision = options.revision ?? 1;
  const definitionHash = options.hash ?? hash;
  const approved = options.approved ?? true;
  return {
    id,
    name: id,
    description: '',
    enabled: options.enabled ?? true,
    revision,
    secretBindings: {},
    headerBindings: {},
    trustApproval: approved
      ? {
          revision: options.approvedRevision ?? revision,
          approvedAt: '2026-10-28T00:00:00.000Z',
          risk: 'network',
          definitionHash: options.approvedHash ?? definitionHash,
        }
      : null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    executionMode: 'remote',
    transport: 'streamable_http',
    endpoint: 'https://example.test/mcp',
    executionHash: definitionHash,
  };
}

function observationFixture(
  options: {
    connectorId?: string;
    revision?: number;
    hash?: string;
    state?: CapabilityObservation['state'];
    tools?: number;
  } = {},
): CapabilityObservation {
  return {
    connectorId: options.connectorId ?? 'fixture',
    revision: options.revision ?? 1,
    definitionHash: options.hash ?? hash,
    state: options.state ?? 'connected',
    checkedAt: '2026-10-28T00:00:00.000Z',
    method: 'mcp_discovery',
    protocolVersion: '2025-06-18',
    tools: Array.from({ length: options.tools ?? 0 }, (_, index) => ({
      name: `tool_${index}`,
      role: 'upstream' as const,
    })),
    resourceCount: 0,
    promptCount: 0,
    reason: 'none',
  };
}

describe('discoveryProgress', () => {
  it('reports nothing while no connector is eligible', () => {
    expect(discoveryProgress([], [])).toEqual({
      eligible: 0,
      settled: 0,
      loading: false,
      needsAttention: 0,
      tools: 0,
      percent: 0,
    });
  });

  it('leaves out the disabled, the unapproved and the stale approvals', () => {
    const progress = discoveryProgress(
      [
        connectorFixture({ id: 'disabled', enabled: false }),
        connectorFixture({ id: 'unapproved', approved: false }),
        connectorFixture({ id: 'old-approval', approvedRevision: 0 }),
        connectorFixture({ id: 'other-hash', approvedHash: otherHash }),
        connectorFixture({ id: 'eligible' }),
      ],
      [],
    );
    expect(progress.eligible).toBe(1);
    expect(progress.settled).toBe(0);
    expect(progress.loading).toBe(true);
  });

  it('counts the settled share and rounds the percentage down', () => {
    const progress = discoveryProgress(
      [
        connectorFixture({ id: 'one' }),
        connectorFixture({ id: 'two' }),
        connectorFixture({ id: 'three' }),
      ],
      [
        observationFixture({ connectorId: 'one' }),
        observationFixture({ connectorId: 'two' }),
      ],
    );
    expect(progress.eligible).toBe(3);
    expect(progress.settled).toBe(2);
    expect(progress.percent).toBe(66);
    expect(progress.loading).toBe(true);
  });

  it('counts the failures and the tools of a finished discovery', () => {
    const progress = discoveryProgress(
      [
        connectorFixture({ id: 'one' }),
        connectorFixture({ id: 'two' }),
        connectorFixture({ id: 'three' }),
        connectorFixture({ id: 'four' }),
      ],
      [
        observationFixture({ connectorId: 'one', tools: 3 }),
        observationFixture({ connectorId: 'two', state: 'error' }),
        observationFixture({ connectorId: 'three', state: 'auth_required' }),
        observationFixture({ connectorId: 'four', tools: 2 }),
      ],
    );
    expect(progress.eligible).toBe(4);
    expect(progress.settled).toBe(4);
    expect(progress.loading).toBe(false);
    expect(progress.percent).toBe(100);
    expect(progress.needsAttention).toBe(2);
    expect(progress.tools).toBe(5);
  });

  it.each(staleObservations)(
    'does not settle a connector on $label',
    ({ options }) => {
      const progress = discoveryProgress(
        [connectorFixture({ id: 'one' })],
        [observationFixture({ connectorId: 'one', ...options })],
      );
      expect(progress.settled).toBe(0);
      expect(progress.percent).toBe(0);
      expect(progress.loading).toBe(true);
    },
  );

  it.each(unfinishedStates)(
    'does not settle a connector whose observation is %s',
    (state) => {
      const progress = discoveryProgress(
        [connectorFixture({ id: 'one' })],
        [observationFixture({ connectorId: 'one', state })],
      );
      expect(progress.settled).toBe(0);
      expect(progress.percent).toBe(0);
      expect(progress.loading).toBe(true);
      expect(progress.tools).toBe(0);
    },
  );

  it('counts an unavailable connector as needing attention', () => {
    const progress = discoveryProgress(
      [connectorFixture({ id: 'one' })],
      [observationFixture({ connectorId: 'one', state: 'unavailable' })],
    );
    expect(progress.settled).toBe(1);
    expect(progress.percent).toBe(100);
    expect(progress.needsAttention).toBe(1);
    expect(progress.tools).toBe(0);
  });
});
