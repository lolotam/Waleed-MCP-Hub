import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
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
      () => reject(new Error('Tool search fixture timed out.')),
      15_000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Tool search fixture exited.'));
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
test('persists the per-agent search toggle and searches/invokes tools through the lean catalog', async ({
  page,
}, testInfo) => {
  const row = page.getByTestId('integration-cursor'),
    toggle = row.getByRole('checkbox', {
      name: 'Tool Search Mode (search_tools + call_tool) for Cursor',
      exact: true,
    }),
    before = await get(page, '/api/fixture/report');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(
    page.getByRole('status').filter({ hasText: 'Tool search mode saved.' }),
  ).toBeVisible();
  await expect(
    row.getByText('Tool search active · 2 meta-tools', { exact: true }),
  ).toBeVisible();
  expect(
    (await get(page, '/api/fixture/agents/cursor/catalog')).tools.map(
      (tool: { name: string }) => tool.name,
    ),
  ).toEqual(['search_tools', 'call_tool']);
  expect(
    (await get(page, '/api/fixture/agents/codex/catalog')).tools,
  ).toHaveLength(6);
  const result = (
    await post(page, '/api/fixture/agents/cursor/call', {
      name: 'search_tools',
      arguments: { query: 'fixture_first', limit: 1 },
    })
  ).value;
  expect(result.structuredContent.tools).toHaveLength(1);
  expect(result.structuredContent.tools[0].inputSchema.type).toBe('object');
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/call', {
        name: 'call_tool',
        arguments: {
          name: result.structuredContent.tools[0].name,
          arguments: { value: 'literal' },
        },
      })
    ).value,
  ).not.toHaveProperty('isError', true);
  await row
    .getByRole('combobox', { name: /Profile \/ Tool Set for/ })
    .selectOption('profile');
  await expect(
    page.getByRole('status').filter({ hasText: 'Agent tool set saved.' }),
  ).toBeVisible();
  const scoped = (
    await post(page, '/api/fixture/agents/cursor/call', {
      name: 'search_tools',
      arguments: { query: 'fixture' },
    })
  ).value;
  expect(
    scoped.structuredContent.tools.every((tool: { name: string }) =>
      tool.name.startsWith('connector-0__'),
    ),
  ).toBe(true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await toggle.scrollIntoViewIfNeeded();
    expect(
      await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`tool-search-mode-${width}.png`),
      fullPage: true,
    });
  }
  expect((await get(page, '/api/fixture/report')).effects).toEqual(
    before.effects,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Scan Installed Agents', exact: true })
    .click();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(
    page.getByRole('status').filter({ hasText: 'Tool search mode saved.' }),
  ).toBeVisible();
  await expect(
    row.getByText('Tool search off · full catalog', { exact: true }),
  ).toBeVisible();
  expect(
    (await get(page, '/api/fixture/agents/cursor/catalog')).tools,
  ).toHaveLength(3);
});
test('does not overwrite a newer search-mode setting from a stale window', async ({
  page,
}) => {
  const row = page.getByTestId('integration-cursor'),
    toggle = row.getByRole('checkbox', {
      name: 'Tool Search Mode (search_tools + call_tool) for Cursor',
      exact: true,
    }),
    report = await get(page, '/api/fixture/report');
  expect(
    (
      await post(page, '/api/agents/cursor/tool-search', {
        expectedRevision: report.state.revision,
        toolSearchMode: true,
      })
    ).status,
  ).toBe(200);
  // A refused controlled toggle can roll back before check() verifies its state.
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Tool search mode was not confirmed.' }),
  ).toBeVisible();
  await expect(toggle).toBeDisabled();
  expect(
    (await get(page, '/api/fixture/report')).state.agentToolSearchModes.cursor,
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Refresh tool sets', exact: true })
    .click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
});
