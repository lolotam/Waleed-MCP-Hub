import { fork, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';
let server: ChildProcess;
test.beforeEach(async ({ page }) => {
  server = fork('tests/fixtures/integrations-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Integration fixture startup timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Integration fixture exited.'));
    });
  });
  await page.goto(url);
});
test.afterEach(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((resolve) =>
      server.once('exit', () => resolve()),
    );
    if (server.connected) server.send('shutdown', () => undefined);
    const timer = setTimeout(() => server.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
});
test('scan, integrate, manual save/auto-sync and scoped disconnect preserve other agent settings', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Scan Installed Agents', exact: true })
    .click();
  await expect(page.getByTestId('integration-cursor')).toBeVisible();
  const row = page.getByTestId('integration-cursor');
  await expect(
    row.getByRole('button', { name: '1-Click Integrate', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel(
      'I approve the listed user-file changes and private backups. Existing agents may require reconnect/approval.',
      { exact: true },
    )
    .check();
  await row
    .getByRole('button', { name: '1-Click Integrate', exact: true })
    .click();
  await expect(
    row.getByText('Integrated · configuration only', { exact: true }),
  ).toBeVisible();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/p7-agents-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await page
    .getByLabel('MCP name', { exact: true })
    .fill('Manual browser remote');
  await page
    .getByLabel('Arguments (JSON array, no shell expansion)', { exact: true })
    .fill('{}');
  await expect(
    dialog.getByRole('button', { name: 'Save MCP', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Arguments (JSON array, no shell expansion)', { exact: true })
    .fill('[]');
  await page
    .getByLabel('Connection type', { exact: true })
    .selectOption('streamable_http');
  await page
    .getByLabel('MCP endpoint URL', { exact: true })
    .fill('https://example.test/mcp');
  await page
    .getByLabel('Protected headers (write-only JSON)', { exact: true })
    .fill('{"Authorization":"SYNTHETIC browser manual private"}');
  await page.getByRole('button', { name: 'Save MCP', exact: true }).click();
  await expect(dialog.getByText(/MCP definition saved/)).toBeVisible();
  expect(await dialog.textContent()).not.toContain(
    'SYNTHETIC browser manual private',
  );
  await page.screenshot({
    path: 'test-results/p8-manual-saved.png',
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByText('Manual browser remote', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Scan Installed Agents', exact: true })
    .click();
  await page
    .getByLabel(
      'I approve the listed user-file changes and private backups. Existing agents may require reconnect/approval.',
      { exact: true },
    )
    .check();
  await page
    .getByTestId('integration-cursor')
    .getByRole('button', { name: 'Disconnect', exact: true })
    .click();
  await expect(
    page
      .getByTestId('integration-cursor')
      .getByText('Not Integrated · configuration only', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

for (const type of ['npx', 'uvx'])
  test(`manual ${type} package pins, consent reset and write-only secrets`, async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Connectors', exact: true }).click();
    await page
      .getByRole('button', { name: 'Add Manual MCP', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await page.getByLabel('MCP name', { exact: true }).fill(`Pinned ${type}`);
    await page
      .getByLabel('Connection type', { exact: true })
      .selectOption(type);
    await page
      .getByLabel('Package name', { exact: true })
      .fill('synthetic-mcp');
    await page
      .getByLabel('Exact package version', { exact: true })
      .fill('latest');
    await expect(
      dialog.getByRole('button', { name: 'Save MCP', exact: true }),
    ).toBeDisabled();
    await page
      .getByLabel('Exact package version', { exact: true })
      .fill('1.2.3');
    await page
      .getByLabel('Package executable name (optional)', { exact: true })
      .fill('synthetic-mcp');
    await page
      .getByLabel('Protected environment values (write-only JSON)', {
        exact: true,
      })
      .fill('{"PROVIDER_TOKEN":"SYNTHETIC package form private"}');
    const approval = page.getByLabel(/I trust this exact executable/);
    await approval.check();
    await page
      .getByLabel('Exact package version', { exact: true })
      .fill('1.2.4');
    await expect(approval).not.toBeChecked();
    await approval.check();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/task3-package-${type}-${width}.png`,
        fullPage: true,
      });
    }
    const saved = page.waitForRequest(
      (request) =>
        request.url().endsWith('/api/connectors/manual') &&
        request.method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Save MCP', exact: true }).click();
    expect((await saved).postDataJSON()).toMatchObject({
      type,
      packageName: 'synthetic-mcp',
      packageVersion: '1.2.4',
      entryPoint: 'synthetic-mcp',
      approveExecution: true,
    });
    await expect(dialog.getByText(/MCP definition saved/)).toBeVisible();
    expect(await dialog.textContent()).not.toContain(
      'SYNTHETIC package form private',
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page
      .getByRole('button', { name: new RegExp(`Pinned ${type}`) })
      .click();
    await expect(
      page.getByRole('button', { name: 'Prepare & test package', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  });
