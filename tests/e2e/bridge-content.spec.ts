import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
let server: ChildProcess;
test.beforeEach(async ({ page }) => {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error();
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  server = fork('tests/fixtures/agent-profiles-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Content fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Content fixture exited.'));
    });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Scan Installed Agents', exact: true })
    .click();
  await expect(page.getByTestId('integration-cursor')).toBeVisible();
});
test.afterEach(async () => {
  if (server?.exitCode === null && server.signalCode === null) {
    const done = new Promise<void>((resolve) =>
      server.once('exit', () => resolve()),
    );
    if (server.connected) server.send('shutdown');
    const timer = setTimeout(() => server.kill(), 5000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  }
});
async function get(page: Page, path: string) {
  return page.evaluate(async (path) => (await fetch(path)).json(), path);
}
async function post(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const session = await (await fetch('/api/session')).json(),
        response = await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': session.csrfToken,
          },
          body: JSON.stringify(body),
        });
      return { status: response.status, value: await response.json() };
    },
    { path, body },
  );
}
async function profile(page: Page, agentId: string, id: string) {
  await page
    .getByTestId(`integration-${agentId}`)
    .getByRole('combobox', { name: /Profile \/ Tool Set for/ })
    .selectOption(id);
  await expect(
    page.getByRole('status').filter({ hasText: 'Agent tool set saved.' }),
  ).toBeVisible();
}
test('profile assignment isolates resource/prompt catalogs and reads across live agent sessions', async ({
  page,
}) => {
  await profile(page, 'cursor', 'profile');
  await profile(page, 'codex', 'operations');
  const a = await get(page, '/api/fixture/agents/cursor/resources'),
    b = await get(page, '/api/fixture/agents/codex/resources'),
    ap = await get(page, '/api/fixture/agents/cursor/prompts'),
    bp = await get(page, '/api/fixture/agents/codex/prompts');
  expect(a.resources).toHaveLength(1);
  expect(b.resources).toHaveLength(1);
  expect(a.resources[0].uri).not.toBe(b.resources[0].uri);
  expect(ap.prompts[0].name).toMatch(/^connector-0__/);
  expect(bp.prompts[0].name).toMatch(/^connector-1__/);
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/resource-read', {
        uri: a.resources[0].uri,
      })
    ).value.contents[0],
  ).toMatchObject({
    uri: a.resources[0].uri,
    text: 'Synthetic resource fixture://resource',
  });
  const result = await post(page, '/api/fixture/agents/codex/prompt-get', {
    name: bp.prompts[0].name,
    arguments: { topic: 'SYNTHETIC-CONTENT-ARG' },
  });
  expect(result.status).toBe(200);
  expect(result.value.messages[0].content.text).toContain(
    'SYNTHETIC-CONTENT-ARG',
  );
  const templates = (await get(page, '/api/fixture/agents/cursor/templates'))
    .resourceTemplates;
  expect(templates).toHaveLength(1);
  const uri = new UriTemplate(templates[0].uriTemplate).expand({
    key: 'report',
  });
  expect(
    (await post(page, '/api/fixture/agents/cursor/resource-read', { uri }))
      .value.contents[0],
  ).toMatchObject({
    uri,
    text: 'Synthetic resource fixture://resource/report',
  });
  const before = await get(page, '/api/fixture/report');
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/resource-read', {
        uri: b.resources[0].uri,
      })
    ).status,
  ).toBe(500);
  expect(
    (
      await post(page, '/api/fixture/agents/codex/prompt-get', {
        name: ap.prompts[0].name,
        arguments: { topic: 'private' },
      })
    ).status,
  ).toBe(500);
  const after = await get(page, '/api/fixture/report');
  expect(after.contentReads).toEqual(before.contentReads);
  expect(after.promptGets).toEqual(before.promptGets);
  expect(after.calls).toEqual([0, 0]);
  expect((await get(page, '/api/request-log')).records).toEqual([]);
});
test('reassignment refuses previously discovered handles and Default restores both connector catalogs', async ({
  page,
}) => {
  const resources = (await get(page, '/api/fixture/agents/cursor/resources'))
      .resources,
    prompts = (await get(page, '/api/fixture/agents/cursor/prompts')).prompts;
  expect(resources).toHaveLength(2);
  expect(prompts).toHaveLength(2);
  await profile(page, 'cursor', 'operations');
  const before = await get(page, '/api/fixture/report');
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/resource-read', {
        uri: resources[0].uri,
      })
    ).status,
  ).toBe(500);
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/prompt-get', {
        name: prompts.find((prompt: { name: string }) =>
          prompt.name.startsWith('connector-0__'),
        ).name,
      })
    ).status,
  ).toBe(500);
  expect((await get(page, '/api/fixture/report')).contentReads).toEqual(
    before.contentReads,
  );
  expect(
    (await get(page, '/api/fixture/agents/cursor/resources')).resources,
  ).toHaveLength(1);
  await profile(page, 'cursor', '');
  expect(
    (await get(page, '/api/fixture/agents/cursor/resources')).resources,
  ).toHaveLength(2);
  expect(
    (await get(page, '/api/fixture/agents/cursor/prompts')).prompts,
  ).toHaveLength(2);
});
