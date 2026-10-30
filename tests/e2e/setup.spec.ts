import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { ExportSetupBundleSchema } from '../../packages/contracts/src/setup.js';
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
  server = fork('tests/fixtures/setup-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Setup fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Setup fixture exited.'));
    });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Share & restore setups' }),
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
async function exported(page: Page) {
  return page.evaluate(async () => (await fetch('/api/setup/export')).json());
}
test('downloads zero-secret JSON, reviews collisions, restores protected credentials and preserves policies/overrides', async ({
  page,
}, testInfo) => {
  await expect(
    page.getByText('Exported configs contain zero secrets', { exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export Configuration', exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('setup.json');
  const path = await file.path();
  if (!path) throw new Error();
  const source = await readFile(path, 'utf8'),
    bundle = ExportSetupBundleSchema.parse(JSON.parse(source));
  expect(source).not.toContain('SYNTHETIC-FIXTURE-PROTECTED');
  expect(source).not.toContain('fixture-protected');
  expect(bundle.connectors[0]!.requiredSecrets[0]!.key).toBe('API_KEY');
  bundle.connectors[0]!.name = 'Restored native connector';
  bundle.connectors[0]!.policies = { read: 'ask' };
  bundle.toolOverrides = {
    'connector-0/read': {
      connectorId: 'connector-0',
      originalToolName: 'read',
      alias: 'inspect_restored',
    },
  };
  bundle.agentProfileBindings = { cursor: 'profile' };
  await page.getByLabel('Import Configuration', { exact: true }).setInputFiles({
    name: 'setup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await expect(
    page.getByRole('heading', { name: 'Review setup', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('1 connectors · 1 profiles · 2 ID collisions', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Required credentials (0)',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel('When an identifier already exists', { exact: true })
    .selectOption('overwrite_existing');
  await expect(
    page.getByRole('heading', {
      name: 'Required credentials (1)',
      exact: true,
    }),
  ).toBeVisible();
  const secret = page.getByLabel('connector-0 · API_KEY (environment, raw)', {
    exact: true,
  });
  await expect(secret).toHaveAttribute('type', 'password');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`setup-review-${width}.png`),
      fullPage: true,
    });
  }
  await secret.fill('SYNTHETIC-IMPORTED-PRIVATE');
  await expect(
    page.getByRole('button', { name: 'Apply Setup', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel(
      'I reviewed this setup, its commands, policies and agent assignments.',
      { exact: true },
    )
    .check();
  await page.getByRole('button', { name: 'Apply Setup', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Setup imported.' }),
  ).toBeVisible();
  await expect(secret).toHaveCount(0);
  const restored = await report(page);
  expect(restored.state.connectors[0]).toMatchObject({
    name: 'Restored native connector',
    trustApproval: null,
    toolPolicies: { read: 'ask' },
  });
  expect(restored.state.toolOverrides[0].alias).toBe('inspect_restored');
  expect(restored.state.agentProfileBindings).toEqual({ cursor: 'profile' });
  expect(restored.vaultCount).toBe(2);
  expect(restored.clearedWrites).toBe(true);
  expect(JSON.stringify(restored)).not.toContain('SYNTHETIC-IMPORTED-PRIVATE');
  expect(JSON.stringify(await exported(page))).not.toContain(
    'SYNTHETIC-IMPORTED-PRIVATE',
  );
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
});
test('drop zone accepts a setup; discard clears credentials; malformed uploads cannot change inventory', async ({
  page,
}) => {
  const bundle = await exported(page),
    before = await report(page);
  await page
    .getByLabel('When an identifier already exists', { exact: true })
    .selectOption('overwrite_existing');
  await page.locator('.setup-drop').evaluate((node, source) => {
    const data = new DataTransfer();
    data.items.add(
      new File([source], 'setup.json', { type: 'application/json' }),
    );
    node.dispatchEvent(
      new DragEvent('drop', { bubbles: true, dataTransfer: data }),
    );
  }, JSON.stringify(bundle));
  const secret = page.getByLabel('connector-0 · API_KEY (environment, raw)', {
    exact: true,
  });
  await secret.fill('SYNTHETIC-DISCARDED');
  await page
    .getByRole('button', { name: 'Discard preview', exact: true })
    .click();
  await expect(secret).toHaveCount(0);
  expect((await report(page)).state).toEqual(before.state);
  await page.getByLabel('Import Configuration', { exact: true }).setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      '{"version":1,"version":1,"private":"SYNTHETIC-MALICIOUS"}',
    ),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: 'Setup could not be reviewed.' }),
  ).toBeVisible();
  expect((await report(page)).state).toEqual(before.state);
  await expect(
    page.getByRole('button', { name: 'Apply Setup', exact: true }),
  ).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(
    'SYNTHETIC-MALICIOUS',
  );
});
