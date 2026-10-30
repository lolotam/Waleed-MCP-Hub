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
  const launch = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Agent profile fixture timed out.')),
      15_000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Agent profile fixture exited.'));
    });
  });
  await page.goto(launch);
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
test('assigns separate profiles to integrated agents, updates counts and enforces the resulting catalogs', async ({
  page,
}, testInfo) => {
  const cursor = page.getByTestId('integration-cursor'),
    codex = page.getByTestId('integration-codex'),
    first = cursor.getByRole('combobox', { name: /Profile \/ Tool Set for/ }),
    second = codex.getByRole('combobox', { name: /Profile \/ Tool Set for/ }),
    before = await get(page, '/api/fixture/report');
  await expect(first).toHaveValue('');
  await expect(
    cursor.getByText(/2 eligible connectors · 6 discovered tools/),
  ).toBeVisible();
  await get(page, '/api/fixture/agents/cursor/catalog');
  await get(page, '/api/fixture/agents/codex/catalog');
  await first.selectOption('profile');
  await expect(
    page.getByRole('status').filter({ hasText: 'Agent tool set saved.' }),
  ).toBeVisible();
  await expect(
    cursor.getByText(/1 eligible connectors · 3 discovered tools/),
  ).toBeVisible();
  await second.selectOption('operations');
  await expect(second).toBeEnabled();
  await expect(
    codex.getByText(/1 eligible connectors · 3 discovered tools/),
  ).toBeVisible();
  const a = await get(page, '/api/fixture/agents/cursor/catalog'),
    b = await get(page, '/api/fixture/agents/codex/catalog');
  expect(
    a.tools.every((tool: { name: string }) =>
      tool.name.startsWith('connector-0__'),
    ),
  ).toBe(true);
  expect(
    b.tools.every((tool: { name: string }) =>
      tool.name.startsWith('connector-1__'),
    ),
  ).toBe(true);
  const countBefore = (await get(page, '/api/fixture/report')).calls;
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/call', {
        name: 'connector-1__fixture_first',
      })
    ).value,
  ).toHaveProperty('isError', true);
  expect((await get(page, '/api/fixture/report')).calls).toEqual(countBefore);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await first.scrollIntoViewIfNeeded();
    expect(
      await cursor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`agent-tool-sets-${width}.png`),
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
  await expect(first).toHaveValue('profile');
  await expect(second).toHaveValue('operations');
  await first.selectOption('');
  await expect(first).toBeEnabled();
  await expect(
    cursor.getByText(/2 eligible connectors · 6 discovered tools/),
  ).toBeVisible();
  expect(
    (await get(page, '/api/fixture/agents/cursor/catalog')).tools,
  ).toHaveLength(6);
  expect(
    (await get(page, '/api/fixture/agents/codex/catalog')).tools,
  ).toHaveLength(3);
});
test('does not overwrite a newer assignment from a stale window and refreshes its selector', async ({
  page,
}) => {
  const cursor = page.getByTestId('integration-cursor'),
    select = cursor.getByRole('combobox', { name: /Profile \/ Tool Set for/ }),
    report = await get(page, '/api/fixture/report');
  expect(
    (
      await post(page, '/api/agents/cursor/profile', {
        expectedRevision: report.state.revision,
        profileId: 'profile',
      })
    ).status,
  ).toBe(200);
  await select.selectOption('operations');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Tool set change was not confirmed.' }),
  ).toBeVisible();
  await expect(select).toBeDisabled();
  expect(
    (await get(page, '/api/fixture/report')).state.agentProfileBindings.cursor,
  ).toBe('profile');
  await page
    .getByRole('button', { name: 'Refresh tool sets', exact: true })
    .click();
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('profile');
});
