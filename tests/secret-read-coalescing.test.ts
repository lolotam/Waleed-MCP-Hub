// Incident 2026-10-31: parallel peer startups resolved their credentials one
// PowerShell launch at a time (~1.1 s each), which pushed the first tools/list
// past Claude Code's fetch deadline. Reads that arrive together now share one
// protected-store process, and still never overflow it.
import { expect, it } from 'vitest';
import { coalesceReads } from '../packages/hub-core/src/adapters/secrets/coalesce.js';

// A protected store whose runs stay open until the test answers them.
function heldStore(fits: (items: string[]) => boolean = () => true) {
  const runs: Array<{
    items: string[];
    answer(values: Array<Buffer | undefined>): void;
    fail(): void;
  }> = [];
  let active = 0;
  let peak = 0;
  const read = coalesceReads<string>(
    (items) =>
      new Promise((resolve, reject) => {
        peak = Math.max(peak, ++active);
        const settle = () => active--;
        runs.push({
          items: [...items],
          answer: (values) => (settle(), resolve(values)),
          fail: () => (settle(), reject(new Error('synthetic run failure'))),
        });
      }),
    fits,
  );
  return { read, runs, peak: () => peak };
}
const open = () => new AbortController().signal;
const echo = (items: string[]) => items.map((item) => Buffer.from(item));

it('answers reads that arrive during a run with one next run, never two at once', async () => {
  const store = heldStore();
  const first = store.read('a', open());
  const rest = ['b', 'c', 'd'].map((item) => store.read(item, open()));
  expect(store.runs.map((run) => run.items)).toEqual([['a']]);
  store.runs[0]!.answer(echo(['a']));
  await expect(first).resolves.toEqual(Buffer.from('a'));
  await expect.poll(() => store.runs.length).toBe(2);
  expect(store.runs[1]!.items).toEqual(['b', 'c', 'd']);
  store.runs[1]!.answer(echo(['b', 'c', 'd']));
  expect((await Promise.all(rest)).map(String)).toEqual(['b', 'c', 'd']);
  expect(store.peak()).toBe(1);
});

it('never sends a read cancelled while queued and wipes a value its reader abandoned', async () => {
  const store = heldStore();
  const running = new AbortController();
  const abandoned = store.read('running', running.signal);
  const queued = new AbortController();
  const cancelled = store.read('queued', queued.signal);
  const kept = store.read('kept', open());
  queued.abort();
  running.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
  const late = Buffer.from('secret');
  store.runs[0]!.answer([late]);
  await expect.poll(() => late.every((byte) => byte === 0)).toBe(true);
  await expect.poll(() => store.runs.length).toBe(2);
  expect(store.runs[1]!.items).toEqual(['kept']);
  store.runs[1]!.answer(echo(['kept']));
  await expect(kept).resolves.toEqual(Buffer.from('kept'));
});

it('fails only the reads the store refused, and keeps serving after a failed run', async () => {
  const store = heldStore();
  const blocker = store.read('blocker', open());
  const good = store.read('good', open());
  const refused = store.read('refused', open());
  store.runs[0]!.fail();
  await expect(blocker).rejects.toThrow('Protected read failed.');
  await expect.poll(() => store.runs.length).toBe(2);
  store.runs[1]!.answer([Buffer.from('good'), undefined]);
  await expect(good).resolves.toEqual(Buffer.from('good'));
  await expect(refused).rejects.toThrow('Protected read failed.');
});

it('splits queued reads into runs the store accepts, sending an oversized read alone', async () => {
  const store = heldStore((items) => items.join('').length <= 4);
  const reads = ['first', 'ab', 'cd', 'e', 'toolong'].map((item) =>
    store.read(item, open()),
  );
  const expected = [['first'], ['ab', 'cd'], ['e'], ['toolong']];
  for (const [index, items] of expected.entries()) {
    await expect.poll(() => store.runs.length).toBe(index + 1);
    expect(store.runs[index]!.items).toEqual(items);
    store.runs[index]!.answer(echo(items));
  }
  expect((await Promise.all(reads)).map(String)).toEqual([
    'first',
    'ab',
    'cd',
    'e',
    'toolong',
  ]);
});
