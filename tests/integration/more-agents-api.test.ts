import { afterEach, expect, it } from 'vitest';
import { createHubServer } from '../../apps/server/src/app.js';
import { newAgentIds, moreAgentsFixture } from '../helpers/more-agents.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = moreAgentsFixture(),
    server = await createHubServer({ port: 4177, lifecycle: f.hub });
  cleanup.push(async () => {
    await server.app.close();
    await f.close();
  });
  const base = { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' },
    session = await server.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: base,
      payload: { token: server.issueLaunchToken() },
    }),
    headers = {
      ...base,
      cookie: session.headers['set-cookie']!.toString().split(';')[0]!,
      'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
    };
  const post = (url: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url, headers, payload });
  return { ...f, server, headers, post };
}
it('discovers all 17 synthetic installations without executing or disclosing existing credentials', async () => {
  const f = await fixture(),
    scan = await f.post('/api/agents/scan', {});
  expect(scan.statusCode).toBe(200);
  expect(scan.json().agents).toHaveLength(17);
  expect(
    scan.json().agents.every((agent: { detected: boolean }) => agent.detected),
  ).toBe(true);
  expect(scan.body).not.toContain('SYNTHETIC-EXISTING-PRIVATE');
  expect(f.effects().writes).toBe(0);
  const sets = await f.server.app.inject({
    method: 'GET',
    url: '/api/agents/tool-sets',
    headers: f.headers,
  });
  expect(sets.json().toolSets).toHaveLength(17);
});
it.each(newAgentIds)(
  '%s integrates, scopes/searches and disconnects through protected API routes',
  async (id) => {
    const f = await fixture(),
      agent = (await f.post('/api/agents/scan', {}))
        .json()
        .agents.find((agent: { agentId: string }) => agent.agentId === id);
    const saved = await f.post(`/api/agents/${id}/integrate`, {
      expectedRevision: 0,
      fingerprint: agent.fingerprint,
      confirmConfigurationChange: true,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().agent.status).toBe('integrated');
    expect(saved.body).not.toContain('SYNTHETIC-EXISTING-PRIVATE');
    expect(f.effects()).toMatchObject({ writes: 1, backups: 1 });
    expect(
      (
        await f.post(`/api/agents/${id}/profile`, {
          expectedRevision: 1,
          profileId: 'profile',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.post(`/api/agents/${id}/tool-search`, {
          expectedRevision: 2,
          toolSearchMode: true,
        })
      ).statusCode,
    ).toBe(200);
    const current = await f.hub.integrations.status(id),
      removed = await f.post(`/api/agents/${id}/disconnect`, {
        expectedRevision: 3,
        fingerprint: current.fingerprint,
        confirmConfigurationChange: true,
      });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().agent.status).toBe('not_integrated');
    expect((await f.hub.inventory()).agentProfileBindings?.[id]).toBe(
      'profile',
    );
    expect((await f.hub.inventory()).agentToolSearchModes?.[id]).toBe(true);
  },
);
it('rejects unlaunched/foreign-origin/CSRF integration requests for new agents', async () => {
  const f = await fixture();
  for (const headers of [
    { host: f.headers.host, origin: f.headers.origin },
    { ...f.headers, origin: 'https://foreign.test' },
    { ...f.headers, 'x-csrf-token': 'bad' },
  ])
    expect([401, 403]).toContain(
      (
        await f.server.app.inject({
          method: 'POST',
          url: '/api/agents/goose/integrate',
          headers,
          payload: {
            expectedRevision: 0,
            fingerprint: null,
            confirmConfigurationChange: true,
          },
        })
      ).statusCode,
    );
  expect(f.effects().writes).toBe(0);
});
