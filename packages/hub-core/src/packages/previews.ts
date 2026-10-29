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
}

export interface PreviewStore {
  put(record: PreviewRecord): void;
  take(previewId: string, owner: string): Promise<PreviewRecord>;
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
    jobIds() {
      return new Set([...stored.values()].map((entry) => entry.record.jobId));
    },
    dispose() {
      for (const [previewId] of stored) forget(previewId);
      stored.clear();
    },
  };
}
