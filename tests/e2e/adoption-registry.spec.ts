import { fork, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';
let server: ChildProcess;
test.beforeEach(async ({ page }) => {
  server = fork('tests/fixtures/adoption-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const launch = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error('Build before starting the synthetic adoption fixture.'),
        ),
      15_000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Adoption fixture exited.'));
    });
  });
  await page.goto(launch);
});
test.afterEach(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
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
test('agent adoption reviews secrets without exposing them, requires profile/config consent, and imports without execution approval', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Scan Installed Agents', exact: true })
    .click();
  await page
    .getByTestId('integration-cursor')
    .getByRole('button', { name: 'Import agent configs', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', {
      name: 'Review import configuration',
      exact: true,
    }),
  ).toBeVisible();
  expect(await dialog.textContent()).not.toContain(
    'SYNTHETIC-BROWSER-ADOPTION-PRIVATE',
  );
  const apply = dialog.getByRole('button', {
    name: 'Apply protected import',
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await dialog.getByLabel('Bind to Synthetic profile', { exact: true }).check();
  await dialog
    .getByLabel(
      'I confirm importing the reviewed definitions, protected credentials and profile membership.',
      { exact: true },
    )
    .check();
  await expect(apply).toBeDisabled();
  await dialog
    .getByLabel(
      'Replace only selected source entries with the Hub bridge and keep an encrypted recovery copy. Unselected entries stay unchanged.',
      { exact: true },
    )
    .check();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/task5-adoption-${width}.png`,
      fullPage: true,
    });
  }
  await apply.click();
  await expect(dialog.getByText(/Import completed/)).toBeVisible();
  const report = await (
    await page.request.get('http://127.0.0.1:4197/api/fixture-report')
  ).json();
  expect(report).toMatchObject({
    sourceContainsSecret: false,
    preservedComment: true,
    hasBridge: true,
    buffersCleared: true,
  });
  expect(report.state.connectors[0]).toMatchObject({
    executionMode: 'package',
    trustApproval: null,
  });
  expect(report.state.profiles[0].connectorIds).toHaveLength(1);
});
test('registry discovery pre-fills a pinned connection but never imports publisher secrets or grants approval', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Browse MCP Registry', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Search official registry', { exact: true })
    .fill('synthetic');
  await dialog
    .getByRole('button', { name: 'Search registry', exact: true })
    .click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/task5-registry-${width}.png`,
      fullPage: true,
    });
  }
  await dialog
    .getByRole('button', { name: 'Review npx connection', exact: true })
    .click();
  await expect(dialog.getByLabel('Package name', { exact: true })).toHaveValue(
    'synthetic-registry-mcp',
  );
  await expect(
    dialog.getByLabel('Exact package version', { exact: true }),
  ).toHaveValue('1.2.3');
  await expect(
    dialog.getByLabel('Protected environment values (write-only JSON)', {
      exact: true,
    }),
  ).toHaveValue('');
  expect(await dialog.textContent()).not.toContain(
    'SYNTHETIC-PUBLISHER-DO-NOT-PREFILL',
  );
  await expect(
    dialog.getByLabel(/I trust this exact executable/),
  ).not.toBeChecked();
  await dialog
    .getByLabel('Protected environment values (write-only JSON)', {
      exact: true,
    })
    .fill('{"API_TOKEN":"SYNTHETIC-USER-ENTERED-PRIVATE"}');
  await dialog.getByRole('button', { name: 'Save MCP', exact: true }).click();
  await expect(dialog.getByText(/MCP definition saved/)).toBeVisible();
  const report = await (
    await page.request.get('http://127.0.0.1:4197/api/fixture-report')
  ).json();
  expect(report.state.connectors[0]).toMatchObject({
    executionMode: 'package',
    package: { name: 'synthetic-registry-mcp', version: '1.2.3' },
    trustApproval: null,
  });
  expect(JSON.stringify(report)).not.toContain(
    'SYNTHETIC-USER-ENTERED-PRIVATE',
  );
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
