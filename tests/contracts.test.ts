import { describe, expect, it } from 'vitest';
import {
  ConnectorSchema,
  CreateProfileSchema,
  EndpointSchema,
  StateSchema,
  IdSchema,
} from '@waleed/contracts';
import { emptyState } from '@waleed/hub-core';
import { syntheticConnector } from './fixtures/native-connector.js';

describe('browser-safe contracts', () => {
  it('retains exact native arguments as inert data', () => {
    expect(ConnectorSchema.parse(syntheticConnector)).toEqual(
      syntheticConnector,
    );
  });
  it('rejects ambiguous transports, unknown fields, plaintext bindings and oversized inputs', () => {
    expect(
      ConnectorSchema.safeParse({
        ...syntheticConnector,
        endpoint: 'https://example.test/mcp',
      }).success,
    ).toBe(false);
    expect(
      ConnectorSchema.safeParse({ ...syntheticConnector, transport: 'sse' })
        .success,
    ).toBe(false);
    expect(
      ConnectorSchema.safeParse({
        ...syntheticConnector,
        env: { PASSWORD: 'synthetic-only' },
      }).success,
    ).toBe(false);
    expect(
      ConnectorSchema.safeParse({
        ...syntheticConnector,
        arguments: ['x'.repeat(4097)],
      }).success,
    ).toBe(false);
    expect(
      ConnectorSchema.safeParse({ ...syntheticConnector, arguments: ['\0'] })
        .success,
    ).toBe(false);
    expect(
      CreateProfileSchema.safeParse({
        kind: 'create_profile',
        expectedRevision: 0,
        name: 'x'.repeat(101),
        description: '',
      }).success,
    ).toBe(false);
  });
  it.each([
    'not a URL',
    'http://example.test',
    'https://user:pass@example.test',
    'https://example.test?token=synthetic',
    'file:///tmp/no',
    'https://example.test/#token',
  ])('rejects credential-bearing or unsupported endpoint %s', (url) => {
    expect(EndpointSchema.safeParse(url).success).toBe(false);
  });
  it('rejects traversal identifiers and unsupported state versions', () => {
    expect(IdSchema.safeParse('../outside').success).toBe(false);
    expect(
      StateSchema.safeParse({ ...emptyState(), schemaVersion: 99 }).success,
    ).toBe(false);
  });
  it('rejects dangling memberships', () => {
    expect(
      StateSchema.safeParse({
        ...emptyState(),
        profiles: [
          {
            id: 'test',
            name: 'Test',
            description: '',
            revision: 1,
            connectorIds: ['missing'],
            dockerProfileId: null,
            updatedAt: '2026-10-28T00:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
