import { expect, it } from 'vitest';
import { FakeProcessRunner, FakeSecretStore } from './helpers/fake-adapters.js';

it('provides deterministic process and secret fakes without OS side effects', async () => {
  const runner = new FakeProcessRunner();
  const request = {
    executable: 'never-executed.exe',
    arguments: [';not-a-shell'],
    environment: {},
    timeoutMs: 1000,
    outputLimitBytes: 1024,
    signal: new AbortController().signal,
  };
  expect((await runner.run(request)).outcome).toBe('exited');
  expect(runner.requests).toEqual([request]);
  const secrets = new FakeSecretStore();
  await secrets.put('fixture', 'synthetic-only');
  expect(await secrets.has('fixture')).toBe(true);
  expect(await secrets.resolve('fixture')).toBe('synthetic-only');
  expect(JSON.stringify(secrets)).not.toContain('synthetic-only');
  await secrets.delete('fixture');
  await expect(secrets.resolve('fixture')).rejects.toThrow('missing');
});
