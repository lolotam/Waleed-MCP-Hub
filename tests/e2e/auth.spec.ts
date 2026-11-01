import { fork, type ChildProcess } from 'node:child_process';
import { test, expect, type Locator } from '@playwright/test';

// Connector rows are collapsed by default; actions and facts live in the panel.
async function expand(row: Locator) {
  const toggle = row.getByTestId('connector-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
}

let server: ChildProcess;
test.beforeEach(async ({ page }) => {
  server = fork('tests/fixtures/auth-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: '4194' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const launch = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            'Synthetic authentication server did not start. Build first.',
          ),
        ),
      15_000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Synthetic authentication fixture exited.'));
    });
  });
  await page.goto(launch);
});
test.afterEach(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exit = new Promise<void>((resolve) =>
      server.once('exit', () => resolve()),
    );
    if (server.connected) server.send('shutdown', () => undefined);
    // A startup timeout can precede installation of the fixture's IPC listener.
    // Reap only this exact fork handle, never a port owner or unrelated process.
    const timer = setTimeout(() => {
      if (server.exitCode === null && server.signalCode === null) server.kill();
    }, 5000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
  }
});
test('one-way credential save clears inputs, requires fresh approval, then verifies real MCP without exporting credentials', async ({
  page,
}) => {
  const secret = 'SYNTHETIC_BROWSER_APIKEY_0123456789';
  const errors: string[] = [];
  const payloads: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/'))
      void response
        .text()
        .then((text) => payloads.push(text))
        .catch(() => undefined);
  });
  const row = page.getByTestId('connector-key');
  await expand(row);
  await row
    .getByRole('button', { name: 'Authentication', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Authentication — Synthetic API key' }),
  ).toBeVisible();
  await page
    .getByLabel('Header format', { exact: true })
    .selectOption('bearer');
  await page.getByLabel('New credential value', { exact: true }).fill(secret);
  await page
    .getByRole('button', { name: 'Save protected credential', exact: true })
    .click();
  await expect(
    dialog.getByText(/Credential saved, not verified/),
  ).toBeVisible();
  await expect(
    dialog.getByLabel('New credential value', { exact: true }),
  ).toHaveCount(0);
  expect(await dialog.textContent()).not.toContain(secret);
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/auth-credential-saved-${width}.png`,
      fullPage: true,
    });
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(row.getByText(/approval required/).first()).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Test capabilities', exact: true }),
  ).toBeDisabled();
  await row
    .getByRole('button', { name: 'Approve execution', exact: true })
    .click();
  await page
    .getByLabel(
      'I trust this exact executable/image/endpoint and its file/network/download permissions.',
      { exact: true },
    )
    .check();
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
  await row
    .getByRole('button', { name: 'Test capabilities', exact: true })
    .click();
  await expect(row.getByText(/connected · MCP discovery only/)).toBeVisible();
  await row
    .getByRole('button', { name: 'Authentication', exact: true })
    .click();
  const value = page.getByLabel('New credential value', { exact: true });
  await expect(value).toHaveValue('');
  await value.fill('SYNTHETIC-UNSAVED-DO-NOT-RETAIN');
  await page.keyboard.press('Escape');
  await row
    .getByRole('button', { name: 'Authentication', exact: true })
    .click();
  await expect(
    page.getByLabel('New credential value', { exact: true }),
  ).toHaveValue('');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(payloads.join('\n')).not.toContain(secret);
  expect(errors).toEqual([]);
  const report = await (
    await page.request.get('http://127.0.0.1:4194/api/fixture-report')
  ).json();
  expect(report.keyMethods).not.toContain('tools/call');
  expect(report.retainedBuffersZeroed).toBe(true);
});
test('supported OAuth shows provider/scope, handles consent and verifies before success', async ({
  page,
  context,
}) => {
  const row = page.getByTestId('connector-oauth');
  await expand(row);
  await row
    .getByRole('button', { name: 'Authentication', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Requested scopes: read/)).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Sign in and verify', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel('I approve this provider, scope and capability discovery.', {
      exact: true,
    })
    .check();
  await dialog
    .getByRole('button', { name: 'Sign in and verify', exact: true })
    .click();
  await expect(
    dialog.getByRole('link', {
      name: 'Continue to verified provider',
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/auth-awaiting-consent.png',
    fullPage: true,
  });
  const popupPromise = context.waitForEvent('page');
  await dialog
    .getByRole('link', { name: 'Continue to verified provider', exact: true })
    .click();
  const popup = await popupPromise;
  await expect(
    popup.getByText(
      'Authorization response received. Return to the local hub.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect.poll(() => new URL(popup.url()).search).toBe('');
  await expect(
    dialog.getByText('MCP discovery passed. No upstream tool was called.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('link', {
      name: 'Continue to verified provider',
      exact: true,
    }),
  ).toHaveCount(0);
  await popup.close();
  expect(await page.content()).not.toContain('SYNTHETIC_OAUTH_ACCESS');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.screenshot({
    path: 'test-results/auth-oauth-verified.png',
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(row.getByText(/connected · MCP discovery only/)).toBeVisible();
  const report = await (
    await page.request.get('http://127.0.0.1:4194/api/fixture-report')
  ).json();
  expect(report.oauth.methods).not.toContain('tools/call');
  expect(report.retainedBuffersZeroed).toBe(true);
});
test('cancelled OAuth closes the listener and never fabricates a connected state', async ({
  page,
}) => {
  const row = page.getByTestId('connector-oauth');
  await expand(row);
  await row
    .getByRole('button', { name: 'Authentication', exact: true })
    .click();
  await page
    .getByLabel('I approve this provider, scope and capability discovery.', {
      exact: true,
    })
    .check();
  await page
    .getByRole('button', { name: 'Sign in and verify', exact: true })
    .click();
  await expect(
    page.getByRole('link', {
      name: 'Continue to verified provider',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Cancel sign-in', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    row.getByText(/auth_required · MCP discovery only/),
  ).toBeVisible();
  await expect(row.getByText(/connected · MCP discovery only/)).toHaveCount(0);
  const report = await (
    await page.request.get('http://127.0.0.1:4194/api/fixture-report')
  ).json();
  expect(report.stored).toBe(0);
  expect(report.oauth.tokenRequests).toBe(0);
});
