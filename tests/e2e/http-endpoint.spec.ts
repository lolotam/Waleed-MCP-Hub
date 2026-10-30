import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '@playwright/test';

let server: ChildProcess;
test.beforeEach(async ({ page, context }) => {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error();
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  server = fork('tests/fixtures/http-endpoint-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('HTTP endpoint fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('HTTP endpoint fixture exited.'));
    });
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(url);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'HTTP endpoint', exact: true }),
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
test('generates a scoped one-time token, copies a usable config, invokes MCP, lists only previews and revokes', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const section = page.locator('.http-endpoints');
  await section
    .getByRole('button', { name: 'Generate Client Token', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Generate Client Token',
    exact: true,
  });
  await expect(dialog.getByLabel('Token label', { exact: true })).toBeFocused();
  await dialog
    .getByLabel('Token label', { exact: true })
    .fill('Cursor workstation');
  await dialog
    .getByLabel('Agent identity', { exact: true })
    .selectOption('cursor');
  await dialog
    .getByLabel('Profile restriction', { exact: true })
    .selectOption('profile');
  await dialog
    .getByRole('button', { name: 'Generate token', exact: true })
    .click();
  const oneTime = page.getByRole('dialog', {
    name: 'Copy your client token now',
    exact: true,
  });
  const secret = await oneTime
    .getByLabel('One-time client token', { exact: true })
    .inputValue();
  expect(secret).toMatch(/^wmh_live_[a-f0-9]{64}$/);
  await oneTime
    .getByRole('button', { name: 'Copy config snippet', exact: true })
    .click();
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  const config = copied.mcpServers['waleed-mcp-hub'];
  expect(config.headers.Authorization).toBe(`Bearer ${secret}`);
  expect(config.url).toBe(`${new URL(page.url()).origin}/mcp`);
  await oneTime
    .getByRole('button', { name: 'Copy token', exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    secret,
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`http-one-time-${width}.png`),
      mask: [oneTime.locator('textarea')],
      fullPage: true,
    });
  }
  const client = new Client(
    { name: 'playwright-http-client', version: '1' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'connector-0__read',
    ]);
    expect(
      await client.callTool({ name: 'connector-0__read' }),
    ).not.toHaveProperty('isError', true);
    await oneTime
      .getByRole('button', { name: 'Done — hide token', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(section).not.toContainText(secret);
    await expect(
      section.getByRole('button', {
        name: 'Generate Client Token',
        exact: true,
      }),
    ).toBeFocused();
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      section.getByText('Cursor workstation', { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByText(`wmh_live_...${secret.slice(-4)}`, { exact: true }),
    ).toBeVisible();
    const report = await page.evaluate(async () =>
      (await fetch('/api/fixture/report')).json(),
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.calls).toBe(1);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: localStorage, session: sessionStorage }),
      ),
    ).not.toContain(secret);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      await section.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`http-tokens-${width}.png`),
        fullPage: true,
      });
    }
    await section
      .getByRole('button', {
        name: 'Revoke token Cursor workstation',
        exact: true,
      })
      .click();
    await expect(section.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(
      section.getByRole('button', {
        name: 'Revoke token Cursor workstation',
        exact: true,
      }),
    ).toBeDisabled();
    const refused = await fetch(config.url, { headers: config.headers });
    expect(refused.status).toBe(401);
  } finally {
    await client.close();
  }
});
test('does not retain token plaintext across Settings navigation, and refuses stale generation without duplicating a token', async ({
  page,
}) => {
  const section = page.locator('.http-endpoints');
  await section
    .getByRole('button', { name: 'Generate Client Token', exact: true })
    .click();
  await page
    .getByLabel('Token label', { exact: true })
    .fill('<img src=x onerror=alert(1)>');
  await page
    .getByRole('button', { name: 'Generate token', exact: true })
    .click();
  const secret = await page
    .getByLabel('One-time client token', { exact: true })
    .inputValue();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    section.getByText('<img src=x onerror=alert(1)>', { exact: true }),
  ).toBeVisible();
  await expect(section.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(section).not.toContainText(secret);
  // Advance the token revision from another window while this Settings list stays stale.
  await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const list = await (await fetch('/api/http-tokens')).json();
    await fetch('/api/http-tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken,
      },
      body: JSON.stringify({
        expectedRevision: list.revision,
        label: 'Other window',
      }),
    });
  });
  await section
    .getByRole('button', { name: 'Generate Client Token', exact: true })
    .click();
  await page.getByLabel('Token label', { exact: true }).fill('Stale window');
  await page
    .getByRole('button', { name: 'Generate token', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Token generation was not confirmed',
  );
  await expect(
    page.getByLabel('One-time client token', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    section.getByText('Other window', { exact: true }),
  ).toBeVisible();
  await expect(section.getByText('Stale window', { exact: true })).toHaveCount(
    0,
  );
});
