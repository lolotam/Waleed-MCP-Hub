import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connector, ImportPreview } from '@waleed/contracts';
import {
  createImportService,
  createLifecycle,
  emptyState,
} from '@waleed/hub-core';
import { createHubServer } from '../apps/server/src/app.js';
import {
  clearImport,
  normalizeImport,
} from '../packages/hub-core/src/imports/normalize.js';
import { memoryStore } from './helpers/memory-store.js';
import { syntheticConnector } from './fixtures/native-connector.js';

const tempDirs: string[] = [];
const hubs: Awaited<ReturnType<typeof createHubServer>>[] = [];
const services: ReturnType<typeof createImportService>[] = [];
const host = '127.0.0.1:4188';
const origin = `http://${host}`;

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'wmh-proposals-'));
  tempDirs.push(dir);
  return dir;
}

async function setup() {
  const store = memoryStore();
  const lifecycle = createLifecycle(store);
  const hub = await createHubServer({ port: 4188, lifecycle });
  hubs.push(hub);
  return { hub, store, lifecycle };
}

async function login(hub: Awaited<ReturnType<typeof createHubServer>>) {
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host, origin },
    payload: { token: hub.issueLaunchToken() },
  });
  return {
    host,
    origin,
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': response.json<{ csrfToken: string }>().csrfToken,
  };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  for (const hub of hubs.splice(0)) {
    await hub.app.close();
  }
  for (const s of services.splice(0)) {
    s.close();
  }
  vi.useRealTimers();
});

describe(
  'npx import entries become package proposals',
  { timeout: 60_000 },
  () => {
    it('converts an npx entry to a package proposal, drops secrets, and clears memory warnings', () => {
      const sentinel = 'sentinel-proposal-value-9';
      const entrySource = {
        command: 'npx',
        args: ['-y', 'pkg@1.2.3', '--flag'],
        env: { API_TOKEN: sentinel },
      };
      const draft = normalizeImport(
        JSON.stringify({
          mcpServers: {
            test: entrySource,
          },
        }),
      );
      try {
        const entry = draft.entries[0]!;
        expect(entry.packageProposal).toEqual({
          name: 'pkg',
          version: '1.2.3',
          arguments: ['--flag'],
          envNames: ['API_TOKEN'],
        });
        expect(entry.definition).toBeNull();
        expect(entry.selected).toBe(false);
        expect(entry.warnings).toContain('package_download');
        expect(entry.warnings).not.toContain('secrets_memory_only');
        expect(entry.warnings).not.toContain('unpinned_package');
        expect(draft.secrets.size).toBe(0);
        expect(draft.references).toHaveLength(0);

        const svc = createImportService();
        services.push(svc);
        const preview = svc.preview(
          {
            source: JSON.stringify({
              mcpServers: {
                test: entrySource,
              },
            }),
            expectedRevision: 0,
          },
          'owner',
          emptyState(),
          false,
        );
        expect(JSON.stringify(preview)).not.toContain(sentinel);
      } finally {
        clearImport(draft);
      }
    });

    it('handles package versions, scopes, --yes flag, and environment literal names', () => {
      for (const spec of ['pkg', 'pkg@latest', 'pkg@^1.2.0']) {
        const draft = normalizeImport(
          JSON.stringify({
            mcpServers: { test: { command: 'npx', args: [spec] } },
          }),
        );
        try {
          expect(draft.entries[0]!.packageProposal).toMatchObject({
            name: 'pkg',
            version: null,
          });
        } finally {
          clearImport(draft);
        }
      }

      {
        const draft = normalizeImport(
          JSON.stringify({
            mcpServers: {
              test: { command: 'npx', args: ['@scope/pkg@2.0.0'] },
            },
          }),
        );
        try {
          expect(draft.entries[0]!.packageProposal).toEqual({
            name: '@scope/pkg',
            version: '2.0.0',
            arguments: [],
            envNames: [],
          });
        } finally {
          clearImport(draft);
        }
      }

      {
        const draftYes = normalizeImport(
          JSON.stringify({
            mcpServers: {
              test: { command: 'npx', args: ['--yes', 'pkg@1.0.0', '--flag'] },
            },
          }),
        );
        const draftY = normalizeImport(
          JSON.stringify({
            mcpServers: {
              test: { command: 'npx', args: ['-y', 'pkg@1.0.0', '--flag'] },
            },
          }),
        );
        try {
          expect(draftYes.entries[0]!.packageProposal).toEqual({
            name: 'pkg',
            version: '1.0.0',
            arguments: ['--flag'],
            envNames: [],
          });
          expect(draftY.entries[0]!.packageProposal).toEqual(
            draftYes.entries[0]!.packageProposal,
          );
        } finally {
          clearImport(draftYes);
          clearImport(draftY);
        }
      }

      {
        const draft = normalizeImport(
          JSON.stringify({
            mcpServers: {
              test: {
                command: 'npx',
                args: ['-y', 'pkg@1.2.3'],
                env: {
                  Z_TOKEN: 'secret-val-z',
                  A_TOKEN: 'secret-val-a',
                },
                environmentLiterals: {
                  NODE_ENV: 'production',
                },
              },
            },
          }),
        );
        try {
          expect(draft.entries[0]!.packageProposal?.envNames).toEqual([
            'A_TOKEN',
            'NODE_ENV',
            'Z_TOKEN',
          ]);
        } finally {
          clearImport(draft);
        }
      }
    });

    it('refuses invalid npx specs and options, keeping inline_program for -c', () => {
      const refusals = [
        { label: 'npx -p pkg cmd', args: ['-p', 'pkg', 'cmd'] },
        { label: 'npx --package pkg cmd', args: ['--package', 'pkg', 'cmd'] },
        { label: 'npx --registry x pkg', args: ['--registry', 'x', 'pkg'] },
        { label: 'npx github:org/repo', args: ['github:org/repo'] },
        { label: 'npx org/repo', args: ['org/repo'] },
        { label: 'npx git+https://h/r.git', args: ['git+https://h/r.git'] },
        { label: 'npx https://h/p.tgz', args: ['https://h/p.tgz'] },
        { label: 'npx file:../p', args: ['file:../p'] },
        { label: 'npx ./local', args: ['./local'] },
        { label: 'npx C:\\p', args: ['C:\\p'] },
        { label: 'npx pkg@npm:other', args: ['pkg@npm:other'] },
        { label: 'npx with no arguments', args: [] },
        { label: 'npx Bad_Name', args: ['Bad_Name'] },
      ];

      for (const { label, args } of refusals) {
        const draft = normalizeImport(
          JSON.stringify({
            mcpServers: {
              test: { command: 'npx', args },
            },
          }),
        );
        try {
          const entry = draft.entries[0]!;
          expect(
            entry.definition,
            `definition should be null for ${label}`,
          ).toBeNull();
          expect(
            entry.packageProposal,
            `packageProposal should be falsy for ${label}`,
          ).toBeFalsy();
          expect(
            entry.issues,
            `issues should contain package_spec for ${label}`,
          ).toContainEqual({
            code: 'invalid_command',
            field: 'package_spec',
          });
        } finally {
          clearImport(draft);
        }
      }

      {
        const draft = normalizeImport(
          JSON.stringify({
            mcpServers: {
              test: { command: 'npx' },
            },
          }),
        );
        try {
          const entry = draft.entries[0]!;
          expect(entry.definition).toBeNull();
          expect(entry.packageProposal).toBeFalsy();
          expect(entry.issues).toContainEqual({
            code: 'invalid_command',
            field: 'package_spec',
          });
        } finally {
          clearImport(draft);
        }
      }

      {
        const draft = normalizeImport(
          JSON.stringify({
            mcpServers: {
              test: { command: 'npx', args: ['-c', 'x'] },
            },
          }),
        );
        try {
          const entry = draft.entries[0]!;
          expect(entry.definition).toBeNull();
          expect(entry.packageProposal).toBeFalsy();
          expect(entry.issues).toEqual([
            { code: 'invalid_command', field: 'inline_program' },
          ]);
          expect(entry.issues.some((i) => i.field === 'package_spec')).toBe(
            false,
          );
        } finally {
          clearImport(draft);
        }
      }
    });

    it('refuses an npx entry whose arguments carry credentials', () => {
      const draft = normalizeImport(
        JSON.stringify({
          mcpServers: {
            test: {
              command: 'npx',
              args: ['-y', 'pkg@1.2.3', '--token=abc123'],
            },
          },
        }),
      );
      try {
        const entry = draft.entries[0]!;
        expect(entry.packageProposal).toBeFalsy();
        expect(entry.definition).toBeNull();
        expect(entry.issues.length).toBeGreaterThan(0);
        expect(
          entry.issues.some((item) => item.code === 'credential_in_definition'),
        ).toBe(true);
      } finally {
        clearImport(draft);
      }
    });

    it('keeps ordinary native definition for uvx with package_download and no proposal', () => {
      const draft = normalizeImport(
        JSON.stringify({
          mcpServers: {
            test: {
              command: 'uvx',
              args: ['tool==1.2.3'],
            },
          },
        }),
      );
      try {
        const entry = draft.entries[0]!;
        expect(entry.packageProposal).toBeFalsy();
        expect(entry.definition).not.toBeNull();
        expect(entry.definition).toMatchObject({
          executionMode: 'native',
          executable: 'uvx',
          arguments: ['tool==1.2.3'],
        });
        expect(entry.warnings).toContain('package_download');
      } finally {
        clearImport(draft);
      }
    });

    it('service preview handles mixed import, proposal-only blocker, select rejection, rename, and existing connector', () => {
      const svc = createImportService();
      services.push(svc);

      const mixedSource = {
        mcpServers: {
          toolEntry: {
            command: 'tool',
            args: ['--flag'],
          },
          proposalEntry: {
            command: 'npx',
            args: ['-y', 'pkg@1.2.3'],
          },
        },
      };
      const mixedPreview = svc.preview(
        {
          source: JSON.stringify(mixedSource),
          expectedRevision: 0,
        },
        'owner',
        emptyState(),
        false,
      );
      expect(mixedPreview.selectionReady).toBe(true);
      expect(mixedPreview.effects.proposedConnectorCount).toBe(1);
      expect(mixedPreview.effects.downloads).toEqual([]);
      expect(mixedPreview.entries).toHaveLength(2);
      const proposalEntry = mixedPreview.entries.find(
        (e) => e.name === 'proposalEntry',
      )!;
      expect(proposalEntry).toBeDefined();
      expect(proposalEntry.packageProposal).toEqual({
        name: 'pkg',
        version: '1.2.3',
        arguments: [],
        envNames: [],
      });
      expect(proposalEntry.selected).toBe(false);

      const proposalOnlySource = {
        mcpServers: {
          proposalOnly: {
            command: 'npx',
            args: ['-y', 'pkg@1.2.3'],
          },
        },
      };
      const proposalOnlyPreview = svc.preview(
        {
          source: JSON.stringify(proposalOnlySource),
          expectedRevision: 0,
        },
        'owner',
        emptyState(),
        false,
      );
      expect(proposalOnlyPreview.blockers).toContain('no_selection');
      expect(proposalOnlyPreview.selectionReady).toBe(false);

      expect(() =>
        svc.select(
          proposalOnlyPreview.id,
          {
            expectedRevision: 0,
            entries: [
              {
                key: proposalOnlyPreview.entries[0]!.key,
                name: proposalOnlyPreview.entries[0]!.name,
                id: proposalOnlyPreview.entries[0]!.id,
                selected: true,
              },
            ],
          },
          'owner',
          emptyState(),
          false,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid' }));

      const renamedPreview = svc.select(
        proposalOnlyPreview.id,
        {
          expectedRevision: 0,
          entries: [
            {
              key: proposalOnlyPreview.entries[0]!.key,
              name: 'Renamed Proposal',
              id: 'renamed-proposal',
              selected: false,
            },
          ],
        },
        'owner',
        emptyState(),
        false,
      );
      expect(renamedPreview.entries[0]!.name).toBe('Renamed Proposal');
      expect(renamedPreview.entries[0]!.id).toBe('renamed-proposal');
      expect(renamedPreview.entries[0]!.selected).toBe(false);

      const stateWithExisting = emptyState();
      stateWithExisting.connectors.push({
        ...syntheticConnector,
        id: 'existing-id',
        name: 'existing-id',
      });
      const previewWithExisting = svc.preview(
        {
          source: JSON.stringify({
            mcpServers: {
              'existing-id': {
                command: 'npx',
                args: ['-y', 'pkg@1.2.3'],
              },
            },
          }),
          expectedRevision: 0,
        },
        'owner',
        stateWithExisting,
        false,
      );
      expect(previewWithExisting.entries[0]!.conflicts).toEqual([]);
      expect(previewWithExisting.blockers).not.toContain('conflicts');
    });

    it('HTTP save-preview returns create_connectors for mixed import, applies only the ordinary connector, and conceals sentinels', async () => {
      await createTempDir();
      const { hub, lifecycle } = await setup();
      const headers = await login(hub);
      const sentinel = 'sentinel-proposal-value-9';
      const mixedSource = {
        mcpServers: {
          'ordinary-tool': {
            command: 'tool',
            args: ['--help'],
          },
          'npx-proposal': {
            command: 'npx',
            args: ['-y', 'pkg@1.2.3', '--flag'],
            env: { API_TOKEN: sentinel },
          },
        },
      };
      const bodies: string[] = [];

      const previewRes = await hub.app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        headers,
        payload: {
          source: JSON.stringify(mixedSource),
          expectedRevision: 0,
        },
      });
      expect(previewRes.statusCode).toBe(200);
      bodies.push(previewRes.body);
      const preview = previewRes.json<ImportPreview>();
      expect(preview.selectionReady).toBe(true);

      const saveRes = await hub.app.inject({
        method: 'POST',
        url: `/api/imports/${preview.id}/save-preview`,
        headers,
        payload: { expectedRevision: 0 },
      });
      expect(saveRes.statusCode).toBe(200);
      bodies.push(saveRes.body);
      const operation = saveRes.json<{ id: string; kind: string }>();
      expect(operation.kind).toBe('create_connectors');

      const applyRes = await hub.app.inject({
        method: 'POST',
        url: '/api/operations/apply',
        headers,
        payload: { previewId: operation.id },
      });
      expect(applyRes.statusCode).toBe(202);
      bodies.push(applyRes.body);
      await lifecycle.drain();

      const connectorsRes = await hub.app.inject({
        method: 'GET',
        url: '/api/connectors',
        headers,
      });
      expect(connectorsRes.statusCode).toBe(200);
      bodies.push(connectorsRes.body);
      const { connectors } = connectorsRes.json<{ connectors: Connector[] }>();
      expect(connectors).toHaveLength(1);
      expect(connectors[0]!.name).toBe('ordinary-tool');

      expect(bodies.length).toBeGreaterThanOrEqual(4);
      for (const body of bodies) {
        expect(body).not.toContain(sentinel);
      }
    });
  },
);
