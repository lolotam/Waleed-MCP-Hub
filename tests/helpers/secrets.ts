import type { SecretBackend } from '@waleed/hub-core';

export function memorySecrets() {
  const values = new Map<string, Buffer>();
  const reads: Buffer[] = [];
  const writes: Buffer[] = [];
  const idsRead: string[] = [];
  const locks = new Map<string, Promise<void>>();
  const backend: SecretBackend = {
    async lock(id, signal) {
      const before = locks.get(id) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(
        id,
        before.then(() => next),
      );
      await before;
      if (signal.aborted) {
        release();
        signal.throwIfAborted();
      }
      return async () => {
        release();
      };
    },
    async replace(id, value) {
      if (!values.has(id)) throw new Error('Synthetic credential missing.');
      values.get(id)!.fill(0);
      writes.push(value);
      values.set(id, Buffer.from(value));
    },
    async has(id) {
      return values.has(id);
    },
    async put(id, value) {
      if (values.has(id)) throw new Error('Immutable synthetic secret.');
      writes.push(value);
      values.set(id, Buffer.from(value));
    },
    async read(id) {
      idsRead.push(id);
      const source = values.get(id);
      if (!source) throw new Error('Synthetic credential missing.');
      const value = Buffer.from(source);
      reads.push(value);
      return value;
    },
    async delete(id) {
      values.get(id)?.fill(0);
      values.delete(id);
    },
  };
  return {
    backend,
    values,
    reads,
    writes,
    idsRead,
    close() {
      for (const value of values.values()) value.fill(0);
      values.clear();
    },
  };
}
