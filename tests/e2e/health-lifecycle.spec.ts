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
  server = fork('tests/fixtures/health-lifecycle-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Health fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Health fixture exited.'));
    });
  });
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Connectors', exact: true }),
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
test('shows Needs Re-auth on collapsed connectors, opens authentication in one click, and checks health without tools', async ({
  page,
}, testInfo) => {
  const expired = page.getByTestId('connector-connector-1');
  await expect(
    expired.getByLabel('Needs Re-auth for Expired OAuth', { exact: true }),
  ).toBeVisible();
  await expired
    .getByRole('button', { name: 'Re-authenticate Expired OAuth', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Authentication — Expired OAuth' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Close authentication dialog', exact: true })
    .click();
  await page.getByRole('button', { name: 'Check Health', exact: true }).click();
  await expect
    .poll(async () => {
      const result = await get(page, '/api/health/connectors');
      return result.connectors.map((item: { status: string }) => item.status);
    })
    .toEqual(['healthy', 'needs_reauth', 'needs_reauth']);
  await expect(
    page.getByLabel('Needs Re-auth for Revoked OAuth', { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  expect((await get(page, '/api/fixture/report')).methods).not.toContain(
    'tools/call',
  );
  expect(
    JSON.stringify(await get(page, '/api/health/connectors')),
  ).not.toContain('SYNTHETIC-HEALTH');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`needs-reauth-${width}.png`),
      fullPage: true,
    });
  }
});
test('persists startup/background/tray settings, reflects live status, and refuses stale windows safely', async ({
  page,
}, testInfo) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const startup = page.getByRole('checkbox', {
      name: 'Start with Windows',
      exact: true,
    }),
    background = page.getByRole('checkbox', {
      name: 'Automatic background health checks',
      exact: true,
    }),
    tray = page.getByRole('checkbox', {
      name: 'Keep running in tray when the app window closes',
      exact: true,
    });
  await expect(startup).not.toBeChecked();
  await startup.check();
  await expect(
    page.getByRole('status').filter({ hasText: 'Start with Windows enabled' }),
  ).toBeVisible();
  expect((await get(page, '/api/lifecycle/startup')).enabled).toBe(true);
  await background.check();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Lifecycle preferences saved.' }),
  ).toBeVisible();
  await tray.uncheck();
  await expect
    .poll(
      async () =>
        (await get(page, '/api/lifecycle/preferences')).keepRunningInTray,
    )
    .toBe(false);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(startup).toBeChecked();
  await expect(background).toBeChecked();
  await expect(tray).not.toBeChecked();
  expect(
    (
      await post(page, '/api/lifecycle/startup', {
        enabled: false,
        expectedState: 'enabled',
      })
    ).status,
  ).toBe(200);
  await startup.uncheck();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Startup change was not confirmed.' }),
  ).toBeVisible();
  await expect(startup).not.toBeChecked();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`lifecycle-settings-${width}.png`),
      fullPage: true,
    });
  }
});
