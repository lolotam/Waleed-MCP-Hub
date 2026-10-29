import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImportService, emptyState } from '@waleed/hub-core';
import type { ImportPreview } from '@waleed/contracts';
import { importSecret, mixedImport } from './fixtures/imports.js';
import { syntheticConnector } from './fixtures/native-connector.js';

const services: ReturnType<typeof createImportService>[] = [];
function service(now?: () => number) {
  const value = createImportService(now);
  services.push(value);
  return value;
}
const input = (value: unknown = mixedImport) => ({
  source: JSON.stringify(value),
  expectedRevision: 0,
});
const selection = (preview: ImportPreview) => ({
  expectedRevision: preview.expectedRevision,
  entries: preview.entries.map(({ key, name, id, selected }) => ({
    key,
    name,
    id,
    selected,
  })),
});
afterEach(() => {
  services.splice(0).forEach((service) => service.close());
  vi.useRealTimers();
});

describe('owner-scoped, memory-only import preview lifecycle', () => {
  it('is sanitized, revision bound and non-applicable, with explicit zero-effect scope', () => {
    const state = emptyState();
    const before = structuredClone(state);
    const imports = service();
    const preview = imports.preview(input(), 'a', state, false);
    expect(preview).toMatchObject({
      selectionReady: true,
      applySupported: false,
      expectedRevision: 0,
      effects: {
        scope: 'preview_only',
        files: [],
        affectedAgents: [],
        registryWrites: false,
        secretStoreWrites: false,
        processes: 0,
        networkRequests: 0,
        proposedConnectorCount: 3,
      },
    });
    expect(preview.effects.downloads).toEqual([
      'package_download_on_execution',
      'image_pull_on_execution',
    ]);
    expect(preview.secretReferences).toHaveLength(3);
    expect(JSON.stringify(preview)).not.toContain(importSecret);
    expect(state).toEqual(before);
    expect('apply' in imports).toBe(false);
    expect('resolve' in imports).toBe(false);
    preview.entries[0]!.name = 'mutated client clone';
    expect(
      imports.read(preview.id, 'a', state, false).entries[0]!.name,
    ).not.toBe('mutated client clone');
  });
  it('restricts reads, selection and cancellation to the owning session', () => {
    const imports = service();
    const state = emptyState();
    const preview = imports.preview(input(), 'a', state, false);
    expect(() => imports.read(preview.id, 'b', state, false)).toThrow(
      'missing or expired',
    );
    expect(() =>
      imports.select(preview.id, selection(preview), 'b', state, false),
    ).toThrow();
    expect(() => imports.cancel(preview.id, 'b')).toThrow();
    expect(imports.read(preview.id, 'a', state, false).selectionReady).toBe(
      true,
    );
  });
  it('detects duplicate normalized names and IDs and requires renaming or deselection', () => {
    const imports = service();
    const state = emptyState();
    const preview = imports.preview(
      input({
        servers: {
          One: { name: 'Same', id: 'same', command: 'tool' },
          Two: { name: ' same ', id: 'same', command: 'tool' },
        },
      }),
      'a',
      state,
      false,
    );
    expect(preview.blockers).toContain('conflicts');
    expect(preview.entries[0]!.conflicts).toEqual([
      'duplicate_name',
      'duplicate_id',
    ]);
    const changes = selection(preview);
    changes.entries[1]!.name = 'Different';
    changes.entries[1]!.id = 'different';
    expect(
      imports.select(preview.id, changes, 'a', state, false).selectionReady,
    ).toBe(true);
  });
  it('never silently replaces existing names or IDs, including Unicode/case-equivalent names', () => {
    const imports = service();
    const state = emptyState();
    state.connectors.push({
      ...syntheticConnector,
      name: 'SERVICE',
      id: 'existing',
    });
    const preview = imports.preview(
      input({ name: 'Ｓｅｒｖｉｃｅ', id: 'existing', command: 'tool' }),
      'a',
      state,
      false,
    );
    expect(preview.entries[0]!.conflicts).toEqual([
      'existing_name',
      'existing_id',
    ]);
    const changes = selection(preview);
    changes.entries[0]!.selected = false;
    expect(
      imports.select(preview.id, changes, 'a', state, false).blockers,
    ).toEqual(['no_selection']);
    expect(state.connectors).toHaveLength(1);
  });
  it('requires explicit deselection of invalid entries rather than silently accepting partial configs', () => {
    const imports = service();
    const state = emptyState();
    const preview = imports.preview(
      input({
        servers: {
          Bad: { command: 'tool', cwd: 'unsupported' },
          Good: { command: 'tool' },
        },
      }),
      'a',
      state,
      false,
    );
    expect(preview.blockers).toEqual(['invalid_selection']);
    const changes = selection(preview);
    changes.entries[0]!.selected = false;
    expect(
      imports.select(preview.id, changes, 'a', state, false).selectionReady,
    ).toBe(true);
  });
  it('rejects duplicate/unknown/missing selection keys and does not mutate an accepted selection', () => {
    const imports = service();
    const state = emptyState();
    const preview = imports.preview(input(), 'a', state, false);
    for (const entries of [
      selection(preview).entries.slice(1),
      preview.entries.map(() => selection(preview).entries[0]),
      selection(preview).entries.map((entry) => ({ ...entry, key: 'unknown' })),
    ])
      expect(() =>
        imports.select(
          preview.id,
          { expectedRevision: 0, entries },
          'a',
          state,
          false,
        ),
      ).toThrow();
    expect(imports.read(preview.id, 'a', state, false)).toEqual(preview);
  });
  it('does not allow a rename to disclose extracted credentials', () => {
    const imports = service();
    const state = emptyState();
    const preview = imports.preview(input(), 'a', state, false);
    const changes = selection(preview);
    changes.entries[0]!.name = importSecret;
    expect(() =>
      imports.select(preview.id, changes, 'a', state, false),
    ).toThrow('credential values');
    expect(
      JSON.stringify(imports.read(preview.id, 'a', state, false)),
    ).not.toContain(importSecret);
  });
  it('expires private drafts on time, not only on the next request', () => {
    vi.useFakeTimers();
    const imports = service();
    const state = emptyState();
    const preview = imports.preview(input(), 'a', state, false);
    vi.advanceTimersByTime(5 * 60_000);
    expect(() => imports.read(preview.id, 'a', state, false)).toThrow(
      'missing or expired',
    );
  });
  it('discards drafts on cancel, logout, replacement (even invalid), and shutdown', () => {
    const imports = service();
    const state = emptyState();
    for (const discard of [
      (id: string) => imports.cancel(id, 'a'),
      () => imports.revoke('a'),
      () => {
        expect(() =>
          imports.preview({ bad: true }, 'a', state, false),
        ).toThrow();
      },
    ]) {
      const preview = imports.preview(input(), 'a', state, false);
      discard(preview.id);
      expect(() => imports.read(preview.id, 'a', state, false)).toThrow();
    }
    const prior = imports.preview(input(), 'a', state, false);
    const next = imports.preview(input(), 'a', state, false);
    expect(() => imports.read(prior.id, 'a', state, false)).toThrow();
    imports.close();
    expect(() => imports.read(next.id, 'a', state, false)).toThrow();
    expect(() => imports.preview(input(), 'a', state, false)).toThrow('closed');
  });
  it('rejects stale creation/selection/read and destroys stale secrets rather than rebasing', () => {
    const imports = service();
    const state = emptyState();
    expect(() =>
      imports.preview({ ...input(), expectedRevision: 1 }, 'a', state, false),
    ).toThrow('Inventory changed');
    const preview = imports.preview(input(), 'a', state, false);
    state.revision++;
    expect(() => imports.read(preview.id, 'a', state, false)).toThrow(
      'Inventory changed',
    );
    state.revision = 0;
    expect(() => imports.read(preview.id, 'a', state, false)).toThrow(
      'missing or expired',
    );
    const another = imports.preview(input(), 'a', state, false);
    expect(() =>
      imports.select(
        another.id,
        { ...selection(another), expectedRevision: 9 },
        'a',
        state,
        false,
      ),
    ).toThrow('revision changed');
    expect(() => imports.read(another.id, 'a', state, false)).toThrow();
  });
  it('bounds global retention, and cancellation immediately frees capacity', () => {
    const imports = service();
    const state = emptyState();
    const previews = Array.from({ length: 20 }, (_, index) =>
      imports.preview(input(), `owner-${index}`, state, false),
    );
    expect(() => imports.preview(input(), 'overflow', state, false)).toThrow(
      'Too many',
    );
    imports.cancel(previews[0]!.id, 'owner-0');
    expect(
      imports.preview(input(), 'overflow', state, false).selectionReady,
    ).toBe(true);
  });
  it('surfaces recovery blocks and registry capacity without writing anything', () => {
    const imports = service();
    const state = emptyState();
    state.connectors = Array.from({ length: 256 }, (_, index) => ({
      ...syntheticConnector,
      id: `existing-${index}`,
      name: `Existing ${index}`,
    }));
    const preview = imports.preview(input(), 'a', state, true);
    expect(preview.blockers).toEqual([
      'registry_capacity',
      'recovery_required',
    ]);
    expect(preview.applySupported).toBe(false);
  });
});
