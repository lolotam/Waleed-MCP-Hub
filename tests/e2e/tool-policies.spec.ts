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
  server = fork('tests/fixtures/tool-policy-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Policy fixture startup timed out.')),
      15_000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Policy fixture exited.'));
    });
  });
  await page.goto(url);
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
async function post(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch(path, {
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
async function get(page: Page, path: string) {
  return page.evaluate(async (path) => (await fetch(path)).json(), path);
}
async function permissions(page: Page) {
  const row = page.getByTestId('connector-connector-0');
  await row.getByTestId('connector-toggle').click();
  await row
    .locator('summary')
    .filter({ hasText: 'Tools & Permissions' })
    .click();
  return row;
}
test('policy toggles persist, update badges, hide catalog tools and require one-call Ask confirmation', async ({
  page,
}, testInfo) => {
  const row = await permissions(page);
  await expect(
    row.getByLabel('Policy for fixture_first', { exact: true }),
  ).toHaveValue('allow');
  await get(page, '/api/fixture/catalog');
  await row
    .getByLabel('Policy for fixture_first', { exact: true })
    .selectOption('block');
  await expect(row.getByRole('status')).toHaveText(/Permissions saved/);
  await expect(
    row.locator('summary').filter({ hasText: 'Tools & Permissions' }),
  ).toContainText('1 Blocked');
  const catalog = (await get(page, '/api/fixture/catalog')).tools;
  expect(
    catalog.some(
      (tool: { name: string }) => tool.name === 'connector-0__fixture_first',
    ),
  ).toBe(false);
  expect(
    (
      await post(page, '/api/fixture/call', {
        name: 'connector-0__fixture_first',
      })
    ).value,
  ).toMatchObject({ isError: true, content: [{ text: 'tool_blocked' }] });
  await row
    .getByLabel('Policy for fixture_second', { exact: true })
    .selectOption('ask');
  await expect(row.getByRole('status')).toHaveText(/Permissions saved/);
  await expect(
    row.locator('summary').filter({ hasText: 'Tools & Permissions' }),
  ).toContainText('1 Ask');
  expect(
    (
      await post(page, '/api/fixture/call', {
        name: 'connector-0__fixture_second',
        approve: false,
      })
    ).value,
  ).toHaveProperty('isError', true);
  expect(
    (
      await post(page, '/api/fixture/call', {
        name: 'connector-0__fixture_second',
        approve: true,
      })
    ).value,
  ).not.toHaveProperty('isError', true);
  const report = await get(page, '/api/fixture/report');
  expect(report.calls).toBe(1);
  expect(report.prompts).toBe(2);
  expect(report.state.connectors[0].trustApproval).not.toBeNull();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await row.locator('.tool-permissions').scrollIntoViewIfNeeded();
    expect(
      await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`tool-permissions-${width}.png`),
      fullPage: true,
    });
  }
  await page.reload();
  const reloaded = await permissions(page);
  await expect(
    reloaded.getByLabel('Policy for fixture_first', { exact: true }),
  ).toHaveValue('block');
  await expect(
    reloaded.getByLabel('Policy for fixture_second', { exact: true }),
  ).toHaveValue('ask');
  await reloaded
    .getByLabel('Policy for fixture_first', { exact: true })
    .selectOption('allow');
  await expect(reloaded.getByRole('status')).toHaveText(/Permissions saved/);
  await get(page, '/api/fixture/catalog');
  expect(
    (
      await post(page, '/api/fixture/call', {
        name: 'connector-0__fixture_first',
      })
    ).value,
  ).not.toHaveProperty('isError', true);
});
test('rejects stale-window policy saves without overwriting the newer permission', async ({
  page,
}) => {
  const row = await permissions(page);
  const saved = await post(page, '/api/connectors/connector-0/tool-policies', {
    expectedRevision: 0,
    expectedConnectorRevision: 1,
    toolPolicies: { fixture_first: 'block' },
  });
  expect(saved.status).toBe(200);
  await row
    .getByLabel('Policy for fixture_first', { exact: true })
    .selectOption('ask');
  await expect(row.getByRole('alert')).toHaveText(/Refresh inventory/);
  await expect(
    row.getByLabel('Policy for fixture_first', { exact: true }),
  ).toBeDisabled();
  const report = await get(page, '/api/fixture/report');
  expect(report.state.connectors[0].toolPolicies.fixture_first).toBe('block');
  await row
    .getByRole('button', { name: 'Refresh permissions', exact: true })
    .click();
  await expect(
    row.getByLabel('Policy for fixture_first', { exact: true }),
  ).toHaveValue('block');
  await expect(
    row.getByLabel('Policy for fixture_first', { exact: true }),
  ).toBeEnabled();
});
