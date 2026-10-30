import type { PackagePreview } from '@waleed/contracts';
import { PackageFault } from './fault.js';
import { jobDirectory, removeTree } from './store.js';

// The lifetime of a preview: ten minutes from the moment it is stored.
export const PREVIEW_TTL_MS = 600_000;

// A stored preview: the preview itself, the frozen lock it was built from, the
// job folder that holds the staging project and the owner that may use it.
export interface PreviewRecord {
  preview: PackagePreview;
  lock: Uint8Array;
  jobId: string;
  owner: string;
}

export interface PreviewStoreOptions {
  ttlMs?: number;
  now?: () => number;
  packagesDir?: string;
  // The number of previews one owner keeps and the number the store keeps.
  maxPerOwner?: number;
  maxTotal?: number;
}

export interface PreviewStore {
  put(record: PreviewRecord): void;
  take(previewId: string, owner: string): Promise<PreviewRecord>;
  // The preview of a stored record, without spending it: the record stays in
  // the store and its job folder stays on disk.
  peek(previewId: string, owner: string): PackagePreview | null;
  // The job folder id of every stored record. A record that expired but was
  // not swept yet still counts: its folder is still on disk.
  jobIds(): ReadonlySet<string>;
  dispose(): void;
  readonly ttlMs?: number;
}

interface StoredPreview {
  record: PreviewRecord;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export function createPreviewStore(
  options: PreviewStoreOptions = {},
): PreviewStore {
  const ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const packagesDir = options.packagesDir;
  const maxPerOwner = options.maxPerOwner ?? 5;
  const maxTotal = options.maxTotal ?? 50;
  const stored = new Map<string, StoredPreview>();

  // The staging folder of an expired preview is deleted; a folder that cannot
  // be removed stays for the reconciliation pass.
  const dropJob = async (jobId: string): Promise<void> => {
    if (!packagesDir) return;
    try {
      await removeTree(jobDirectory(packagesDir, jobId), packagesDir);
    } catch {
      return;
    }
  };

  const forget = (previewId: string): void => {
    const entry = stored.get(previewId);
    if (!entry) return;
    stored.delete(previewId);
    clearTimeout(entry.timer);
  };

  // The store is capped: an owner keeps a few previews and the store keeps a
  // few more, so a flood of lookups cannot fill the disk with staging
  // folders. The oldest preview goes first: the oldest of its owner for the
  // per-owner cap, the oldest of the store for the total cap.
  const evict = (owner: string): void => {
    for (;;) {
      const ownerEntries = [...stored.values()].filter(
        (entry) => entry.record.owner === owner,
      );
      if (ownerEntries.length > maxPerOwner) {
        const oldest = ownerEntries[0]!;
        forget(oldest.record.preview.previewId);
        void dropJob(oldest.record.jobId);
        continue;
      }
      const globalOldest = [...stored.values()][0];
      if (!globalOldest || stored.size <= maxTotal) return;
      forget(globalOldest.record.preview.previewId);
      void dropJob(globalOldest.record.jobId);
    }
  };

  return {
    ttlMs,
    put(record) {
      const previewId = record.preview.previewId;
      forget(previewId);
      const expiresAt = now() + ttlMs;
      const timer = setTimeout(() => {
        const entry = stored.get(previewId);
        if (!entry) return;
        stored.delete(previewId);
        void dropJob(entry.record.jobId);
      }, ttlMs);
      timer.unref?.();
      stored.set(previewId, { record, expiresAt, timer });
      evict(record.owner);
    },
    async take(previewId, owner) {
      const entry = stored.get(previewId);
      // Another session gets the same answer as for an unknown preview and
      // consumes nothing, so it can neither probe nor spend the owner's preview.
      if (!entry || entry.record.owner !== owner)
        throw new PackageFault('preview_expired');
      // The owner uses a preview once: the record leaves the store either way.
      forget(previewId);
      if (entry.expiresAt <= now()) {
        await dropJob(entry.record.jobId);
        throw new PackageFault('preview_expired');
      }
      return entry.record;
    },
    peek(previewId, owner) {
      const entry = stored.get(previewId);
      // Another session learns nothing: an unknown, a foreign and an expired
      // preview all look the same. Nothing is consumed and nothing is deleted.
      if (!entry || entry.record.owner !== owner) return null;
      if (entry.expiresAt <= now()) return null;
      return structuredClone(entry.record.preview);
    },
    jobIds() {
      return new Set([...stored.values()].map((entry) => entry.record.jobId));
    },
    dispose() {
      for (const [previewId] of stored) forget(previewId);
      stored.clear();
    },
  };
}
