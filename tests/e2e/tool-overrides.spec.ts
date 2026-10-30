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
      () => reject(new Error('Override fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Override fixture exited.'));
    });
  });
  await page.goto(url);
  await expect(page.getByTestId('connector-connector-0')).toBeVisible();
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
async function customize(page: Page) {
  const row = page.getByTestId('connector-connector-0');
  if (
    (await row
      .getByTestId('connector-toggle')
      .getAttribute('aria-expanded')) === 'false'
  )
    await row.getByTestId('connector-toggle').click();
  if (!(await row.locator('details.tool-permissions').getAttribute('open'))) {
    const open = await row
      .locator('details.tool-permissions')
      .evaluate((node) => (node as HTMLDetailsElement).open);
    if (!open) await row.locator('details.tool-permissions > summary').click();
  }
  await row
    .getByRole('button', { name: 'Customize fixture_first', exact: true })
    .click();
  return page.getByRole('dialog', {
    name: 'Customize tool — fixture_first',
    exact: true,
  });
}
test('customizes metadata, executes aliases/original handles and resets to provider defaults', async ({
  page,
}, testInfo) => {
  const before = await get(page, '/api/fixture/report'),
    dialog = await customize(page);
  await dialog
    .getByLabel('Custom Alias (optional)', { exact: true })
    .fill('inspect_records');
  await dialog
    .getByLabel('Custom Description (optional)', { exact: true })
    .fill('Reconcile monthly revenue invoices. Metadata is not permission.');
  await dialog
    .getByLabel('Annotations (JSON object, optional)', { exact: true })
    .fill('{"readOnlyHint":true,"destructiveHint":false}');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`tool-override-${width}.png`),
      fullPage: true,
    });
  }
  await dialog
    .getByRole('button', { name: 'Save override', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByTestId('connector-connector-0');
  await expect(row.getByText('Overridden', { exact: true })).toBeVisible();
  const catalog = await get(page, '/api/fixture/agents/cursor/catalog');
  expect(
    catalog.tools.find(
      (tool: { name: string }) => tool.name === 'inspect_records',
    ),
  ).toMatchObject({
    description:
      'Reconcile monthly revenue invoices. Metadata is not permission.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  });
  for (const name of ['inspect_records', 'connector-0__fixture_first'])
    expect(
      (
        await post(page, '/api/fixture/agents/cursor/call', {
          name,
          arguments: { literal: 'value' },
        })
      ).value,
    ).not.toHaveProperty('isError', true);
  expect((await get(page, '/api/fixture/report')).effects).toEqual(
    before.effects,
  );
  const reset = await customize(page);
  await reset
    .getByRole('button', { name: 'Reset to Default', exact: true })
    .click();
  await expect(reset).toHaveCount(0);
  await expect(row.getByText('Overridden', { exact: true })).toHaveCount(0);
  expect(
    (await get(page, '/api/fixture/agents/cursor/catalog')).tools.some(
      (tool: { name: string }) => tool.name === 'connector-0__fixture_first',
    ),
  ).toBe(true);
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/call', {
        name: 'inspect_records',
      })
    ).value.isError,
  ).toBe(true);
});
test('rejects a stale customization form without overwriting a newer override', async ({
  page,
}) => {
  const report = await get(page, '/api/fixture/report'),
    dialog = await customize(page);
  expect(
    (
      await post(page, '/api/connectors/connector-0/tool-override', {
        expectedRevision: report.state.revision,
        expectedConnectorRevision: 1,
        originalToolName: 'fixture_first',
        override: {
          connectorId: 'connector-0',
          originalToolName: 'fixture_first',
          alias: 'newer_alias',
        },
      })
    ).status,
  ).toBe(200);
  await dialog
    .getByLabel('Custom Alias (optional)', { exact: true })
    .fill('stale_alias');
  await dialog
    .getByRole('button', { name: 'Save override', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Override was not confirmed.',
  );
  expect(
    (await get(page, '/api/fixture/report')).state.toolOverrides[0].alias,
  ).toBe('newer_alias');
});
