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
  server = fork('tests/fixtures/agent-profiles-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port), PLAYGROUND_ECHO: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Playground fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Playground fixture exited.'));
    });
  });
  await page.goto(url);
  await page
    .getByRole('button', { name: 'Playground & Logs', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Tool playground', exact: true }),
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
async function choose(page: Page) {
  await page
    .getByRole('combobox', { name: 'Connector', exact: true })
    .selectOption('connector-0');
  await page.getByRole('button', { name: 'Load tools', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Tool', exact: true })
    .selectOption('fixture_first');
  await expect(
    page.getByLabel('Tool input schema', { exact: true }),
  ).toBeVisible();
}
test('runs only after exact confirmation, redacts echoed input, and shows a live metadata-only row', async ({
  page,
}, testInfo) => {
  await choose(page);
  const args = page.getByRole('textbox', {
      name: 'Arguments (JSON object)',
      exact: true,
    }),
    confirm = page.getByRole('checkbox', {
      name: 'I confirm execution of this exact tool and arguments once.',
      exact: true,
    }),
    run = page.getByRole('button', { name: 'Run Tool', exact: true });
  await expect(run).toBeDisabled();
  const privateValue = 'SYNTHETIC-PLAYGROUND-PRIVATE-INPUT';
  await args.fill(JSON.stringify({ value: privateValue }));
  await confirm.check();
  await args.fill(
    JSON.stringify({
      value: privateValue,
      nested: { value: '<img src=x onerror=alert(1)>' },
    }),
  );
  await expect(confirm).not.toBeChecked();
  await expect(run).toBeDisabled();
  expect((await get(page, '/api/fixture/report')).calls).toEqual([0, 0]);
  await confirm.check();
  await run.click();
  await expect(
    page.getByRole('heading', { name: 'Run status: succeeded', exact: true }),
  ).toBeVisible();
  await expect(args).toHaveValue('');
  await expect(confirm).not.toBeChecked();
  await expect(run).toBeDisabled();
  const output = page.getByLabel('Sanitized tool output', { exact: true });
  await expect(output).toContainText('[redacted]');
  await expect(output).not.toContainText(privateValue);
  expect(await output.locator('img,script,a').count()).toBe(0);
  const row = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: 'Playground', exact: true }),
  });
  await expect(row).toContainText('fixture_first');
  await expect(row).toContainText('success');
  expect((await get(page, '/api/fixture/report')).calls).toEqual([1, 0]);
  expect(JSON.stringify(await get(page, '/api/request-log'))).not.toContain(
    privateValue,
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`playground-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Playground & Logs', exact: true })
    .click();
  await expect(
    page.getByLabel('Sanitized tool output', { exact: true }),
  ).toHaveCount(0);
  await expect(row).toBeVisible();
});
test('streams agent calls into the same table and rejects missing confirmation without execution', async ({
  page,
}) => {
  const invalid = await post(page, '/api/playground/invoke', {
    connectorId: 'connector-0',
    toolName: 'fixture_first',
    arguments: { secret: 'PRIVATE' },
    confirmExecute: false,
  });
  expect(invalid.status).toBe(400);
  expect((await get(page, '/api/fixture/report')).calls).toEqual([0, 0]);
  await get(page, '/api/fixture/agents/cursor/catalog');
  expect(
    (
      await post(page, '/api/fixture/agents/cursor/call', {
        name: 'connector-0__fixture_first',
        arguments: { token: 'SYNTHETIC-AGENT-PRIVATE' },
      })
    ).status,
  ).toBe(200);
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'cursor', exact: true }) });
  await expect(row).toContainText('fixture_first');
  await expect(row).toContainText('success');
  expect(JSON.stringify(await get(page, '/api/request-log'))).not.toContain(
    'SYNTHETIC-AGENT-PRIVATE',
  );
});
test('clears arguments and confirmation when changing tools or leaving the view, with no browser persistence', async ({
  page,
}) => {
  await choose(page);
  const args = page.getByRole('textbox', {
      name: 'Arguments (JSON object)',
      exact: true,
    }),
    confirm = page.getByRole('checkbox', {
      name: 'I confirm execution of this exact tool and arguments once.',
      exact: true,
    });
  await args.fill('{"value":"SYNTHETIC-UNSUBMITTED-PRIVATE"}');
  await confirm.check();
  await page
    .getByRole('combobox', { name: 'Tool', exact: true })
    .selectOption('fixture_second');
  await expect(args).toHaveValue('');
  await expect(confirm).not.toBeChecked();
  await args.fill('{"value":"SYNTHETIC-UNSUBMITTED-PRIVATE"}');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Playground & Logs', exact: true })
    .click();
  await choose(page);
  await expect(args).toHaveValue('');
  await expect(confirm).not.toBeChecked();
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    ),
  ).not.toContain('SYNTHETIC');
  expect((await get(page, '/api/fixture/report')).calls).toEqual([0, 0]);
});
