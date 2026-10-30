import { randomUUID } from 'node:crypto';
import {
  ImportPreviewRequestSchema,
  ImportPreviewSchema,
  ImportSelectionSchema,
  type HubState,
  type ImportPreview,
} from '@waleed/contracts';
import { HubError } from '../errors.js';
import {
  clearImport,
  hasControlCharacters,
  normalizeImport,
  type PrivateImport,
} from './normalize.js';

interface Draft {
  owner: string;
  id: string;
  revision: number;
  expires: number;
  normalized: PrivateImport;
  timer: ReturnType<typeof setTimeout>;
}
const fold = (name: string) => name.normalize('NFKC').trim().toLowerCase();

// No process/filesystem/network/secret-store adapter is accepted by this module.
// Its only retained private data is bounded, owner-scoped, short-lived memory.
export function createImportService(now: () => number = Date.now) {
  const drafts = new Map<string, Draft>();
  let closed = false;
  const remove = (draft: Draft) => {
    clearTimeout(draft.timer);
    clearImport(draft.normalized);
    drafts.delete(draft.id);
  };
  const prune = () => {
    for (const draft of drafts.values())
      if (draft.expires <= now()) remove(draft);
  };
  const revoke = (owner: string) => {
    for (const draft of drafts.values())
      if (draft.owner === owner) remove(draft);
  };
  const current = (id: string, owner: string, state: HubState) => {
    prune();
    const draft = drafts.get(id);
    if (closed || !draft || draft.owner !== owner)
      throw new HubError(
        'not_found',
        'Import preview is missing or expired. Paste a fresh configuration.',
      );
    if (state.revision !== draft.revision) {
      remove(draft);
      throw new HubError(
        'conflict',
        'Inventory changed. The private draft was discarded; create a new preview.',
      );
    }
    return draft;
  };
  const project = (
    draft: Draft,
    state: HubState,
    recoveryBlocked: boolean,
  ): ImportPreview => {
    const entries = structuredClone(draft.normalized.entries);
    // A package proposal is never imported: it is installed on its own, so it
    // takes part in no conflict, blocker or effect.
    const selected = entries.filter(
      (entry) => entry.selected && !entry.packageProposal,
    );
    for (const entry of selected) {
      if (
        selected.some(
          (other) =>
            other.key !== entry.key && fold(other.name) === fold(entry.name),
        )
      )
        entry.conflicts.push('duplicate_name');
      if (
        selected.some(
          (other) => other.key !== entry.key && other.id === entry.id,
        )
      )
        entry.conflicts.push('duplicate_id');
      if (
        state.connectors.some((other) => fold(other.name) === fold(entry.name))
      )
        entry.conflicts.push('existing_name');
      if (state.connectors.some((other) => other.id === entry.id))
        entry.conflicts.push('existing_id');
    }
    const blockers: ImportPreview['blockers'] = [];
    if (!selected.length) blockers.push('no_selection');
    if (selected.some((entry) => !entry.definition || entry.issues.length))
      blockers.push('invalid_selection');
    if (selected.some((entry) => entry.conflicts.length))
      blockers.push('conflicts');
    if (state.connectors.length + selected.length > 256)
      blockers.push('registry_capacity');
    if (recoveryBlocked) blockers.push('recovery_required');
    const definitions = selected.flatMap((entry) =>
      entry.definition ? [entry.definition] : [],
    );
    const references = new Set(
      definitions.flatMap((definition) => [
        ...Object.values(definition.headerBindings),
        ...Object.values(definition.secretBindings),
      ]),
    );
    const warnings = new Set(selected.flatMap((entry) => entry.warnings));
    return ImportPreviewSchema.parse({
      id: draft.id,
      expectedRevision: draft.revision,
      expiresAt: new Date(draft.expires).toISOString(),
      format: draft.normalized.format,
      entries,
      blockers,
      selectionReady: !blockers.length,
      applySupported: false,
      secretReferences: draft.normalized.references.filter((reference) =>
        references.has(reference.id),
      ),
      effects: {
        scope: 'preview_only',
        files: [],
        affectedAgents: [],
        registryWrites: false,
        secretStoreWrites: false,
        processes: 0,
        networkRequests: 0,
        proposedConnectorCount: selected.length,
        downloads: [
          ...(warnings.has('package_download')
            ? ['package_download_on_execution' as const]
            : []),
          ...(warnings.has('image_pull')
            ? ['image_pull_on_execution' as const]
            : []),
        ],
        permissions: [
          ...(warnings.has('network_access')
            ? ['network_on_execution' as const]
            : []),
          ...(warnings.has('host_file_access')
            ? ['host_files_on_execution' as const]
            : []),
          ...(warnings.has('image_execution_approval')
            ? ['container_on_execution' as const]
            : []),
        ],
      },
    });
  };
  return {
    preview(
      raw: unknown,
      owner: string,
      state: HubState,
      recoveryBlocked: boolean,
    ): ImportPreview {
      if (closed)
        throw new HubError('unavailable', 'Import previews are closed.');
      // Replacement attempts discard the previous secret-bearing draft even if
      // the new request is invalid. There is never a hidden browser draft history.
      revoke(owner);
      prune();
      const input = ImportPreviewRequestSchema.parse(raw);
      if (input.expectedRevision !== state.revision)
        throw new HubError(
          'conflict',
          'Inventory changed. Refresh and preview again.',
        );
      if (drafts.size >= 20)
        throw new HubError(
          'busy',
          'Too many private import previews. Cancel an existing draft or wait for expiry.',
        );
      const normalized = normalizeImport(input.source);
      const id = randomUUID();
      const draft: Draft = {
        id,
        owner,
        revision: state.revision,
        normalized,
        expires: now() + 5 * 60_000,
        timer: setTimeout(() => {
          const found = drafts.get(id);
          if (found) remove(found);
        }, 5 * 60_000),
      };
      draft.timer.unref();
      try {
        const response = project(draft, state, recoveryBlocked);
        drafts.set(id, draft);
        return response;
      } catch (error) {
        remove(draft);
        throw error;
      }
    },
    read(
      id: string,
      owner: string,
      state: HubState,
      recoveryBlocked: boolean,
    ): ImportPreview {
      return project(current(id, owner, state), state, recoveryBlocked);
    },
    select(
      id: string,
      raw: unknown,
      owner: string,
      state: HubState,
      recoveryBlocked: boolean,
    ): ImportPreview {
      const draft = current(id, owner, state);
      const input = ImportSelectionSchema.parse(raw);
      if (input.expectedRevision !== draft.revision) {
        remove(draft);
        throw new HubError(
          'conflict',
          'Preview revision changed. Create a new preview.',
        );
      }
      if (
        input.entries.length !== draft.normalized.entries.length ||
        new Set(input.entries.map((entry) => entry.key)).size !==
          input.entries.length ||
        input.entries.some(
          (entry) =>
            !draft.normalized.entries.some(
              (candidate) => candidate.key === entry.key,
            ),
        )
      )
        throw new HubError('invalid', 'Select each known entry exactly once.');
      if (
        input.entries.some((change) => {
          const entry = draft.normalized.entries.find(
            (candidate) => candidate.key === change.key,
          );
          return change.selected && !!entry?.packageProposal;
        })
      )
        throw new HubError(
          'invalid',
          'Package proposals are installed with Install, not imported.',
        );
      for (const entry of input.entries) {
        if (
          hasControlCharacters(entry.name) ||
          [...draft.normalized.secrets.values()].some((value) =>
            [
              value.toString('utf8'),
              value.toString('utf8').replace(/^Bearer\s+/i, ''),
            ].some((secret) =>
              [entry.name, entry.id].some(
                (text) =>
                  text === secret ||
                  (secret.length >= 4 && text.includes(secret)),
              ),
            ),
          )
        )
          throw new HubError(
            'invalid',
            'Names and identifiers must not contain credential values or control characters.',
          );
      }
      for (const change of input.entries) {
        const entry = draft.normalized.entries.find(
          (entry) => entry.key === change.key,
        )!;
        entry.name = change.name;
        entry.id = change.id;
        entry.selected = change.selected;
        if (entry.definition) {
          entry.definition.name = change.name;
          entry.definition.id = change.id;
        }
      }
      return project(draft, state, recoveryBlocked);
    },
    cancel(id: string, owner: string) {
      prune();
      const draft = drafts.get(id);
      if (!draft || draft.owner !== owner)
        throw new HubError(
          'not_found',
          'Import preview is missing or expired.',
        );
      remove(draft);
      return { discarded: true as const };
    },
    revoke,
    close() {
      closed = true;
      for (const draft of drafts.values()) remove(draft);
    },
  };
}
