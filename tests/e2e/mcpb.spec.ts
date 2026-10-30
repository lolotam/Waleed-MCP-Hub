import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect } from '@playwright/test';
import { mcpb } from '../helpers/mcpb.js';
let server: ChildProcess, origin: string;
test.beforeEach(async ({ page }) => {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error();
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  server = fork('tests/fixtures/adoption-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const launch = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Bundle fixture startup timed out.')),
      15_000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Bundle fixture exited.'));
    });
  });
  await page.goto(launch);
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
test('reviews a file and typed configuration, installs without approval or execution, and clears protected inputs', async ({
  page,
}, testInfo) => {
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('summary')
    .filter({ hasText: 'Install a .mcpb bundle' })
    .click();
  await dialog
    .getByLabel('Choose .mcpb bundle', { exact: true })
    .setInputFiles({
      name: 'synthetic.mcpb',
      mimeType: 'application/octet-stream',
      buffer: mcpb(),
    });
  const metadata = dialog.getByRole('region', { name: 'Bundle metadata' });
  await expect(metadata).toContainText('synthetic-bundle');
  await expect(metadata).toContainText('Synthetic author');
  await expect(metadata).toContainText('1.2.3');
  const token = dialog.getByLabel('API token (required) · protected', {
    exact: true,
  });
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('SYNTHETIC-BROWSER-MCPB-PRIVATE');
  await dialog.getByLabel('Item count', { exact: true }).fill('5');
  await dialog.getByLabel('Enable feature', { exact: true }).check();
  await expect(
    dialog.getByRole('button', {
      name: 'Install reviewed bundle',
      exact: true,
    }),
  ).toBeDisabled();
  await dialog.getByLabel(/I confirm installing this reviewed bundle/).check();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`bundle-review-${width}.png`),
      fullPage: true,
    });
  }
  await dialog
    .getByRole('button', { name: 'Install reviewed bundle', exact: true })
    .click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Bundle installed.' }),
  ).toBeVisible();
  await expect(token).toHaveCount(0);
  const report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.state.connectors[0]).toMatchObject({
    executionMode: 'native',
    trustApproval: null,
    bundle: { archiveHash: expect.any(String) },
  });
  expect(JSON.stringify(report)).not.toContain(
    'SYNTHETIC-BROWSER-MCPB-PRIVATE',
  );
  expect(report.buffersCleared).toBe(true);
  expect(report.localMethods).toEqual([]);
});
test('supports dropping a bundle into Import and discarding its private preview', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('summary')
    .filter({ hasText: 'Install a .mcpb bundle' })
    .click();
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], 'drop.mcpb', {
          type: 'application/octet-stream',
        }),
      );
      return data;
    },
    [...mcpb()],
  );
  await dialog
    .locator('.bundle-drop')
    .dispatchEvent('drop', { dataTransfer: transfer });
  await expect(
    dialog.getByRole('region', { name: 'Bundle metadata' }),
  ).toBeVisible();
  await dialog
    .getByLabel('API token (required) · protected', { exact: true })
    .fill('SYNTHETIC-DISCARDED-MCPB-PRIVATE');
  await dialog
    .getByRole('button', { name: 'Discard bundle preview', exact: true })
    .click();
  await expect(
    dialog.getByRole('region', { name: 'Bundle metadata' }),
  ).toHaveCount(0);
  const report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.state.connectors).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
test('rejects malformed archive content with a safe message and no install controls', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('summary')
    .filter({ hasText: 'Install a .mcpb bundle' })
    .click();
  await dialog
    .getByLabel('Choose .mcpb bundle', { exact: true })
    .setInputFiles({
      name: 'bad.mcpb',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('SYNTHETIC-INVALID-PRIVATE'),
    });
  await expect(
    dialog.getByRole('alert').filter({ hasText: 'Bundle review failed' }),
  ).toBeVisible();
  expect(await dialog.textContent()).not.toContain('SYNTHETIC-INVALID-PRIVATE');
  await expect(
    dialog.getByRole('button', {
      name: 'Install reviewed bundle',
      exact: true,
    }),
  ).toHaveCount(0);
});
