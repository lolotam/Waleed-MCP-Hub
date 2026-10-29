import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openSafetyLedger,
  openStateStore,
  stateHash,
  emptyState,
  type SafetyLedger,
  type StateStore,
} from '@waleed/hub-core';
import { journalFixture } from '../helpers/safety.js';

const directories: string[] = [];
const ledgers: SafetyLedger[] = [];
const stores: StateStore[] = [];
async function temporary() {
  const path = await mkdtemp(
    join(
      process.env.HUB_TEST_TEMP ??
        (process.platform === 'win32' ? 'E:\\Dev\\Temp\\opencode' : tmpdir()),
      'hub-safety-',
    ),
  );
  directories.push(path);
  return path;
}
async function ledgerAt(path: string) {
  const ledger = await openSafetyLedger(path);
  ledgers.push(ledger);
  return ledger;
}
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
  for (const store of stores.splice(0)) await store.close();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
const refusal = {
  reason: 'origin_denied',
  route: 'preview',
  method: 'POST',
  status: 403,
};

describe('persistent safety ledger', () => {
  it('locks writers, persists metadata across restart, and leaves no temporary files', async () => {
    const path = await temporary();
    const first = await ledgerAt(path);
    await expect(openSafetyLedger(path)).rejects.toMatchObject({
      code: 'busy',
    });
    await first.recordRefusal(refusal);
    await first.close();
    const reopened = await ledgerAt(path);
    expect((await reopened.read()).securityEvents).toHaveLength(1);
    expect((await readdir(path)).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    );
  });
  it('rejects malformed, secret-bearing, oversized, or unsupported persisted data without echoing it', async () => {
    const path = await temporary();
    for (const content of [
      '{SYNTHETIC-PRIVATE-DATA',
      JSON.stringify({
        schemaVersion: 999,
        credential: 'SYNTHETIC-PRIVATE-DATA',
      }),
      'x'.repeat(512 * 1024 + 1),
    ]) {
      await writeFile(join(path, 'safety.json'), content);
      try {
        await openSafetyLedger(path);
        throw new Error('Unexpected successful open.');
      } catch (error) {
        expect(String(error)).not.toContain('SYNTHETIC-PRIVATE-DATA');
      }
      expect(await readdir(path)).not.toContain('safety.lock');
    }
  });
  it('refuses external edits without overwriting them or inventing an empty history', async () => {
    const path = await temporary();
    const ledger = await ledgerAt(path);
    await ledger.recordRefusal(refusal);
    const external = '{SYNTHETIC-EXTERNAL-EDIT';
    await writeFile(join(path, 'safety.json'), external);
    await expect(ledger.read()).rejects.toMatchObject({ code: 'conflict' });
    await expect(ledger.recordRefusal(refusal)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await readFile(join(path, 'safety.json'), 'utf8')).toBe(external);
  });
  it('rejects a junction/symlink runtime directory', async () => {
    const parent = await temporary();
    const target = await temporary();
    const linked = join(parent, 'linked');
    await symlink(
      target,
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(openSafetyLedger(linked)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(await readdir(target)).toHaveLength(0);
  });
  it.each(['before', 'after', 'drift'] as const)(
    'reconciles an interrupted %s save without rewriting registry state',
    async (phase) => {
      const path = await temporary();
      const store = await openStateStore(path);
      stores.push(store);
      const ledger = await ledgerAt(path);
      const before = emptyState();
      const after = { ...emptyState(), revision: 1 };
      const entry = journalFixture();
      entry.beforeHash = stateHash(before);
      entry.afterHash = stateHash(after);
      await ledger.prepare(entry);
      await store.write(
        0,
        phase === 'after' ? after : { ...before, revision: 1 },
      );
      // "before" proves the initial state hash, despite a different file layout.
      if (phase === 'before') {
        await store.close();
        await writeFile(join(path, 'state.json'), JSON.stringify(before));
      } else if (phase === 'drift') {
        await store.close();
        await writeFile(
          join(path, 'state.json'),
          JSON.stringify({ ...before, revision: 9 }),
        );
      } else await store.close();
      await ledger.close();
      const original = await readFile(join(path, 'state.json'), 'utf8');
      const reopenedStore = await openStateStore(path);
      stores.push(reopenedStore);
      const reopenedLedger = await ledgerAt(path);
      await reopenedLedger.reconcile(await reopenedStore.read());
      const recovered = (await reopenedLedger.read()).operations[0]!;
      expect(recovered.phase).toBe(
        phase === 'before'
          ? 'aborted'
          : phase === 'after'
            ? 'committed'
            : 'needs_review',
      );
      expect(await readFile(join(path, 'state.json'), 'utf8')).toBe(original);
      if (phase === 'drift')
        await expect(reopenedLedger.assertWritable()).rejects.toThrow();
      else
        await expect(reopenedLedger.assertWritable()).resolves.toBeUndefined();
    },
  );
});
