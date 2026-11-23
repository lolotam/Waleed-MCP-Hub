import { fork, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
let server: ChildProcess;
// The scan of the agents is the From your agents page under Add.
async function openAgents(page: Page) {
  await page.getByRole('tab', { name: 'Add', exact: true }).click();
  await page
    .getByRole('link', { name: 'From your agents', exact: true })
    .click();
}
test.beforeEach(async ({ page }) => {
  server = fork('tests/fixtures/cloning-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const launch = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Cloning fixture did not start.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Cloning fixture exited.'));
    });
  });
  await page.goto(launch);
  await openAgents(page);
});
test.afterEach(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      server.once('exit', () => resolve()),
    );
    if (server.connected) server.send('shutdown', () => {});
    // A fixture that ignores the shutdown is killed, and teardown still waits
    // for it to exit so the next test never meets its port or files.
    const timer = setTimeout(() => server.kill(), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
});
test('first opening scans agents, clones only the selection with credentials and shows tools and release notification', async ({
  page,
}) => {
  await expect(
    page.getByText('Claude Code · 1 MCPs · found', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Codex · 1 MCPs · found', { exact: true }),
  ).toBeVisible();
  // The count on Settings is visual only; the status text names it and the
  // name of the button stays Settings.
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.nav-item .nav-count')).toHaveText('1');
  await expect(
    page.getByRole('status').getByText('Update available'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Updates', exact: true }).click();
  await expect(
    page.getByText('Version 0.2.0 is available.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Download update', exact: true }),
  ).toHaveAttribute(
    'href',
    'https://github.com/lolotam/Waleed-MCP-Hub/releases/download/v0.2.0/Waleed-MCP-Hub-Setup.exe',
  );
  expect(await page.locator('body').innerText()).not.toContain(
    'SYNTHETIC_FIRST_RUN_COPY_TOKEN',
  );
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await openAgents(page);
  await page
    .getByLabel('Copy primary from Claude Code', { exact: true })
    .check();
  await page.getByLabel(/I reviewed the selected commands/).check();
  await page
    .getByRole('button', { name: 'Clone and connect (1)', exact: true })
    .click();
  await page.getByRole('tab', { name: 'All connectors', exact: true }).click();
  const row = page.getByTestId(/^connector-manual-/);
  await expect(row).toHaveCount(1);
  await row.getByTestId('connector-toggle').click();
  await expect(row.getByText(/connected · MCP discovery only/)).toBeVisible();
  await row.getByText('Tools & Permissions', { exact: false }).click();
  await expect(
    row.getByLabel('Policy for fixture_first', { exact: true }),
  ).toHaveValue('allow');
  const report = await (
    await page.request.get('http://127.0.0.1:4198/api/fixture-report')
  ).json();
  expect(report).toMatchObject({
    sourceUnchanged: true,
    credentialCopied: true,
    names: ['primary'],
  });
  expect(report.methods).not.toContain('tools/call');
});
test('a copied connector with missing authentication remains available for repair', async ({
  page,
}) => {
  await expect(
    page.getByText('Codex · 1 MCPs · found', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Copy needs_auth from Codex', { exact: true }).check();
  await page.getByLabel(/I reviewed the selected commands/).check();
  await page
    .getByRole('button', { name: 'Clone and connect (1)', exact: true })
    .click();
  await page.getByRole('tab', { name: 'All connectors', exact: true }).click();
  const row = page.getByTestId(/^connector-manual-/);
  await expect(row).toHaveCount(1);
  await row.getByTestId('connector-toggle').click();
  await expect(
    row.getByText(/auth_required · MCP discovery only/),
  ).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Authentication', exact: true }),
  ).toBeEnabled();
  const report = await (
    await page.request.get('http://127.0.0.1:4198/api/fixture-report')
  ).json();
  expect(report.names).toEqual(['needs_auth']);
  expect(report.sourceUnchanged).toBe(true);
});

test('a saved copy reports an inventory refresh failure without suggesting another copy', async ({
  page,
}) => {
  await expect(
    page.getByText('Claude Code · 1 MCPs · found', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Copy primary from Claude Code', { exact: true })
    .check();
  await page.getByLabel(/I reviewed the selected commands/).check();
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page
    .getByRole('button', { name: 'Clone and connect (1)', exact: true })
    .click();
  await expect(
    page.getByText(
      'Copies saved, but inventory refresh failed. Refresh inventory before making another change.',
      { exact: true },
    ),
  ).toBeVisible();
  const report = await (
    await page.request.get('http://127.0.0.1:4198/api/fixture-report')
  ).json();
  expect(report.names).toEqual(['primary']);
  expect(report.sourceUnchanged).toBe(true);
});
