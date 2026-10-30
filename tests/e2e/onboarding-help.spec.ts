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
  server = fork('tests/fixtures/onboarding-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Onboarding fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Onboarding fixture exited.'));
    });
  });
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Welcome & safety', exact: true }),
  ).toBeVisible();
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
async function report(page: Page) {
  return page.evaluate(async () => (await fetch('/api/fixture/report')).json());
}
test('steps through the tour without automatic effects, persists Finish with zero connectors, and reruns only on request', async ({
  page,
}, testInfo) => {
  const tour = page.getByRole('region', { name: 'Welcome & safety' });
  expect(await report(page)).toMatchObject({
    writes: 0,
    backups: 0,
    probes: 0,
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`onboarding-${width}.png`),
      fullPage: true,
    });
  }
  await tour.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Connect agents', exact: true }),
  ).toBeVisible();
  await page
    .locator('.onboarding-actions')
    .getByRole('button', { name: 'Back', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Welcome & safety', exact: true }),
  ).toBeFocused();
  for (let step = 0; step < 3; step++)
    await page
      .locator('.onboarding-actions')
      .getByRole('button', { name: 'Next', exact: true })
      .click();
  await expect(
    page.getByRole('heading', { name: 'All set', exact: true }),
  ).toBeVisible();
  expect(await report(page)).toMatchObject({
    writes: 0,
    backups: 0,
    probes: 0,
  });
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(page.locator('.onboarding-wizard')).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Your existing tools stay where they are',
    }),
  ).toBeVisible();
  await expect(page.locator('.onboarding-wizard')).toHaveCount(0);
  expect((await report(page)).onboarding.onboardingCompleted).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('button', { name: 'Re-run Onboarding', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Welcome & safety', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip Tour', exact: true }).click();
  await page.reload();
  await expect(page.locator('.onboarding-wizard')).toHaveCount(0);
});
test('scans agents and integrates only after explicit consent, then opens existing first-MCP review flows', async ({
  page,
}) => {
  await page
    .locator('.onboarding-actions')
    .getByRole('button', { name: 'Next', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Scan Installed Agents', exact: true })
    .click();
  const row = page.getByTestId('integration-cursor');
  await expect(row).toBeVisible();
  for (const id of ['claude-desktop', 'vscode', 'codex', 'opencode'])
    await expect(page.getByTestId(`integration-${id}`)).toBeVisible();
  await expect(
    row.getByRole('button', { name: '1-Click Integrate', exact: true }),
  ).toBeDisabled();
  expect((await report(page)).writes).toBe(0);
  await page
    .getByLabel(
      'I approve the listed user-file changes and private backups. Existing agents may require reconnect/approval.',
    )
    .check();
  await row
    .getByRole('button', { name: '1-Click Integrate', exact: true })
    .click();
  await expect(
    row.getByRole('button', { name: 'Disconnect', exact: true }),
  ).toBeVisible();
  expect(await report(page)).toMatchObject({ writes: 1, backups: 1 });
  await page
    .locator('.onboarding-actions')
    .getByRole('button', { name: 'Next', exact: true })
    .click();
  await page.getByRole('button', { name: /^Managed Packages/ }).click();
  const manual = page.getByRole('dialog');
  await expect(
    manual.getByLabel('Connection type', { exact: true }),
  ).toHaveValue('npx');
  await manual
    .getByRole('button', { name: 'Close manual MCP dialog', exact: true })
    .click();
  await page.getByRole('button', { name: /^Smart Paste/ }).click();
  await expect(
    page.getByRole('dialog').getByText('Smart paste', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close manual MCP dialog', exact: true })
    .click();
  await page.getByRole('button', { name: /^Browse Official Registry/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Find an MCP server' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Close registry browser', exact: true })
    .click();
  expect((await report(page)).state.connectors).toEqual([]);
});
test('opens searchable categorized help, follows guide links, restores focus and fits desktop/mobile', async ({
  page,
}, testInfo) => {
  const help = page
    .locator('header')
    .getByRole('button', { name: 'Help & Guides', exact: true });
  await help.click();
  const drawer = page.getByRole('dialog', {
    name: 'Help & Guides',
    exact: true,
  });
  await expect(
    drawer.getByLabel('Search help topics', { exact: true }),
  ).toBeFocused();
  await drawer
    .getByLabel('Search help topics', { exact: true })
    .fill('exit code -1');
  await drawer
    .getByRole('navigation', { name: 'Help topics' })
    .getByRole('button', {
      name: 'Troubleshooting Exit code -1 or a process will not start',
      exact: true,
    })
    .click();
  await expect(
    drawer.getByRole('heading', {
      name: 'Exit code -1 or a process will not start',
      exact: true,
    }),
  ).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect(
      await drawer.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`help-${width}.png`),
      fullPage: true,
    });
  }
  await drawer
    .getByLabel('Search help topics', { exact: true })
    .fill('no_such_topic_xyz');
  await expect(
    drawer.getByText(
      'No matching topics. Try a shorter search or another category.',
    ),
  ).toBeVisible();
  await drawer.getByLabel('Search help topics', { exact: true }).fill('Cursor');
  await drawer
    .getByLabel('Category', { exact: true })
    .selectOption('Connecting Agents');
  await drawer
    .getByRole('navigation', { name: 'Help topics' })
    .getByRole('button', { name: 'Connecting Agents Cursor', exact: true })
    .click();
  await expect(
    drawer.getByRole('heading', { name: 'Cursor', exact: true }),
  ).toBeVisible();
  await drawer
    .getByRole('button', {
      name: 'Read full connecting-agents.md',
      exact: true,
    })
    .click();
  await expect(
    drawer.getByRole('heading', {
      name: 'Connect your AI agents to the hub',
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.locator('dialog script, dialog img, dialog iframe').count(),
  ).toBe(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(help).toBeFocused();
  expect(await report(page)).toMatchObject({
    writes: 0,
    backups: 0,
    probes: 0,
  });
});
test('does not dismiss onboarding when saving fails, and allows a safe retry', async ({
  page,
}) => {
  await page.route('**/api/settings/onboarding', async (route) => {
    if (route.request().method() === 'POST') await route.abort();
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Skip Tour', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Onboarding preference was not confirmed.' }),
  ).toBeVisible();
  await expect(page.locator('.onboarding-wizard')).toBeVisible();
  expect((await report(page)).onboarding.onboardingCompleted).toBe(false);
  await page.unroute('**/api/settings/onboarding');
  await page.getByRole('button', { name: 'Skip Tour', exact: true }).click();
  await expect(page.locator('.onboarding-wizard')).toHaveCount(0);
});
test('a missing local help chunk does not crash the workspace', async ({
  page,
}) => {
  await page.route('**/assets/HelpDrawer-*.js', (route) => route.abort());
  await page
    .locator('header')
    .getByRole('button', { name: 'Help & Guides', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Local guides could not load',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Welcome & safety', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Close help notice', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Local guides could not load',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await report(page)).toMatchObject({
    writes: 0,
    backups: 0,
    probes: 0,
  });
});
