import { fork, type ChildProcess } from 'node:child_process';
import { test, expect, type Locator, type Page } from '@playwright/test';

let server: ChildProcess;
test.beforeEach(async ({ page }) => {
  server = fork('tests/fixtures/lifecycle-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: '4193' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const launchUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error('Synthetic lifecycle server did not start. Build first.'),
        ),
      15_000,
    );
    server.once('message', (message: { launchUrl?: string }) => {
      clearTimeout(timer);
      if (message.launchUrl) resolve(message.launchUrl);
      else reject(new Error('No launch URL.'));
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Synthetic lifecycle server exited.'));
    });
  });
  await page.goto(launchUrl);
});
test.afterEach(async () => {
  if (server?.connected) {
    const exited = new Promise<void>((resolve) =>
      server.once('exit', () => resolve()),
    );
    server.send('shutdown');
    await exited;
  }
});
async function save(page: Page, source: unknown) {
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  await page
    .getByLabel('Configuration JSON', { exact: true })
    .fill(JSON.stringify(source));
  await page
    .getByRole('button', { name: 'Preview configuration', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Preview local save', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Apply reviewed change', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Operation completed', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
async function applyDialog(page: Page) {
  await page
    .getByRole('button', { name: 'Preview operation', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Apply reviewed change', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Operation completed', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
// Connector rows are collapsed by default; actions and facts live in the panel.
async function expand(row: Locator) {
  const toggle = row.getByTestId('connector-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
}
async function approve(page: Page, id: string) {
  const row = page.getByTestId(`connector-${id}`);
  await expand(row);
  await row
    .getByRole('button', { name: 'Approve execution', exact: true })
    .click();
  await page
    .getByLabel(
      'I trust this exact executable/image/endpoint and its file/network/download permissions.',
      { exact: true },
    )
    .check();
  await applyDialog(page);
}

test('save, approve, automatic real MCP discovery, profile membership/materialization, disable and remove remain distinct', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await save(page, {
    id: 'fixture',
    name: 'Fixture remote',
    url: 'https://example.test/mcp',
  });
  const row = page.getByTestId('connector-fixture');
  await expect(row.getByText('Needs approval', { exact: true })).toBeVisible();
  await expand(row);
  await expect(row.getByText(/approval required/).first()).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Test capabilities', exact: true }),
  ).toBeDisabled();
  await approve(page, 'fixture');
  await row
    .getByRole('button', { name: 'Test capabilities', exact: true })
    .click();
  await expect(row.getByText(/connected · MCP discovery only/)).toBeVisible();
  await row.getByText('Definition and capabilities', { exact: true }).click();
  await expect(
    row.getByText('mcp-add · gateway management', { exact: true }),
  ).toBeVisible();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/lifecycle-connectors-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create profile', exact: true })
    .click();
  await page
    .getByLabel('Profile name', { exact: true })
    .fill('Disposable workflow');
  await page
    .getByRole('button', { name: 'Preview changes', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Apply local change', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Profile created', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit membership', exact: true })
    .click();
  await page
    .getByLabel('Profile settings and connectorIds (JSON)', { exact: true })
    .fill(
      JSON.stringify({
        name: 'Disposable workflow',
        description: '',
        connectorIds: ['fixture'],
        enabled: true,
      }),
    );
  await applyDialog(page);
  await page
    .getByRole('button', { name: 'Apply profile', exact: true })
    .click();
  await applyDialog(page);
  await expect(
    page.getByText('Snapshot applied — reconnect may be needed', {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/lifecycle-profile-applied.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await expand(row);
  await row.getByRole('button', { name: 'Disable', exact: true }).click();
  await applyDialog(page);
  await expand(row);
  await expect(
    row.getByTestId('connector-toggle').getByText('disabled', { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByText('approval required', { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Test capabilities', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await expect(
    page.getByText('Snapshot stale — apply again', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Dematerialize', exact: true })
    .click();
  await applyDialog(page);
  await page
    .getByRole('button', { name: 'Remove profile', exact: true })
    .click();
  await applyDialog(page);
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await expand(row);
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await applyDialog(page);
  await expect(row).toHaveCount(0);
  const report = await (
    await page.request.get('http://127.0.0.1:4193/api/fixture-report')
  ).json();
  expect(report.methods).not.toContain('tools/call');
  expect(report.managedFiles).toBe(0);
  expect(report.dockerProfiles).toBe(0);
  expect(errors).toEqual([]);
});

test('automatically shows tools after approval and reload, and persists all three tool permissions', async ({
  page,
}) => {
  await save(page, {
    id: 'fixture',
    name: 'Fixture remote',
    url: 'https://example.test/mcp',
  });
  await approve(page, 'fixture');
  let row = page.getByTestId('connector-fixture');
  await expect(row.getByText(/connected · MCP discovery only/)).toBeVisible();
  await row.getByText('Tools & Permissions', { exact: false }).click();
  const policy = row.getByLabel('Policy for fixture_first', { exact: true });
  await expect(policy).toHaveValue('allow');
  for (const value of ['ask', 'block', 'allow']) {
    await policy.selectOption(value);
    await expect(row.getByRole('status')).toContainText('Permissions saved.');
    await expect(policy).toBeEnabled();
    await expect(policy).toHaveValue(value);
  }
  await policy.selectOption('block');
  await expect(row.getByRole('status')).toContainText('Permissions saved.');
  await page.reload();
  row = page.getByTestId('connector-fixture');
  await expand(row);
  await expect(row.getByText(/connected · MCP discovery only/)).toBeVisible();
  await row.getByText('Tools & Permissions', { exact: false }).click();
  await expect(
    row.getByLabel('Policy for fixture_first', { exact: true }),
  ).toHaveValue('block');
  const report = await (
    await page.request.get('http://127.0.0.1:4193/api/fixture-report')
  ).json();
  expect(report.methods).not.toContain('tools/call');
});

test('a failed auth check does not erase a healthy connector and editing invalidates execution approval', async ({
  page,
}) => {
  await save(page, {
    servers: {
      Healthy: { id: 'healthy', url: 'https://example.test/mcp' },
      Auth: { id: 'auth', url: 'https://example.test/auth' },
    },
  });
  await approve(page, 'healthy');
  await approve(page, 'auth');
  const healthy = page.getByTestId('connector-healthy'),
    auth = page.getByTestId('connector-auth');
  await expand(healthy);
  await expand(auth);
  await healthy
    .getByRole('button', { name: 'Test capabilities', exact: true })
    .click();
  await expect(
    healthy.getByText(/connected · MCP discovery only/),
  ).toBeVisible();
  await auth
    .getByRole('button', { name: 'Test capabilities', exact: true })
    .click();
  await expect(
    auth.getByText(/auth_required · MCP discovery only/),
  ).toBeVisible();
  await expect(
    healthy.getByText(/connected · MCP discovery only/),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/lifecycle-auth-required.png',
    fullPage: true,
  });
  await healthy.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByLabel('Editable connector definition (JSON)', {
    exact: true,
  });
  const value = JSON.parse(await editor.inputValue());
  value.endpoint = 'https://example.test/changed';
  await editor.fill(JSON.stringify(value));
  await page
    .getByRole('button', { name: 'Preview operation', exact: true })
    .click();
  await page.getByText('Exact definition / context', { exact: true }).click();
  await expect(page.getByRole('dialog').locator('pre')).toContainText(
    'https://example.test/changed',
  );
  await page
    .getByRole('button', { name: 'Apply reviewed change', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Operation completed', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(healthy.getByText(/approval required/).first()).toBeVisible();
  await expect(
    healthy.getByRole('button', { name: 'Test capabilities', exact: true }),
  ).toBeDisabled();
  await expect(healthy.getByText(/untested · not verified/)).toBeVisible();
  expect(
    (
      await (
        await page.request.get('http://127.0.0.1:4193/api/fixture-report')
      ).json()
    ).methods,
  ).not.toContain('tools/call');
});
