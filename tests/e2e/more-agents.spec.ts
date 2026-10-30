import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
const newIds = [
  'windsurf',
  'cline',
  'roo-code',
  'zed',
  'gemini-cli',
  'goose',
  'jetbrains',
  'warp',
];
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
  server = fork('tests/fixtures/more-agents-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('More-agents fixture timed out.')),
      15000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('More-agents fixture exited.'));
    });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Scan Installed Agents', exact: true })
    .click();
  await expect(page.locator('ul.integration-list > li')).toHaveCount(17);
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
test('shows all 17 agent cards, integrates the new eight with scoped profiles/search and safely disconnects', async ({
  page,
}, testInfo) => {
  const consent = page.getByLabel(
    'I approve the listed user-file changes and private backups. Existing agents may require reconnect/approval.',
  );
  for (const id of newIds) {
    const row = page.getByTestId(`integration-${id}`);
    await expect(
      row.getByText('Detected locally', { exact: true }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: '1-Click Integrate', exact: true }),
    ).toBeDisabled();
  }
  expect((await report(page)).effects.writes).toBe(0);
  await consent.check();
  for (const id of newIds) {
    const row = page.getByTestId(`integration-${id}`);
    await row
      .getByRole('button', { name: '1-Click Integrate', exact: true })
      .click();
    await expect(
      row.getByRole('button', { name: 'Disconnect', exact: true }),
    ).toBeVisible();
  }
  const goose = page.getByTestId('integration-goose');
  await goose
    .getByLabel('Profile / Tool Set for Goose', { exact: true })
    .selectOption('profile');
  await goose
    .getByRole('checkbox', {
      name: 'Tool Search Mode (search_tools + call_tool) for Goose',
      exact: true,
    })
    .check();
  await expect(
    goose.getByText('Tool search active · 2 meta-tools', { exact: true }),
  ).toBeVisible();
  expect((await report(page)).state.integrations).toHaveLength(8);
  expect((await report(page)).effects).toMatchObject({ writes: 8, backups: 8 });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.integration-list')
        .evaluate(
          (node) =>
            getComputedStyle(node).gridTemplateColumns.split(' ').length,
        ),
    ).toBe(width === 1440 ? 2 : 1);
    await page.screenshot({
      path: testInfo.outputPath(`agents-${width}.png`),
      fullPage: true,
    });
  }
  for (const id of newIds) {
    const row = page.getByTestId(`integration-${id}`);
    await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(
      row.getByRole('button', { name: '1-Click Integrate', exact: true }),
    ).toBeVisible();
  }
  const end = await report(page);
  expect(end.state.integrations).toEqual([]);
  expect(end.state.agentProfileBindings.goose).toBe('profile');
  expect(end.state.agentToolSearchModes.goose).toBe(true);
  expect(end.effects).toMatchObject({ writes: 16, backups: 16 });
});
test('a stale window cannot overwrite a new agent scope', async ({ page }) => {
  const before = await report(page),
    session = await page.evaluate(async () =>
      (await fetch('/api/session')).json(),
    );
  await page.evaluate(async (csrf) => {
    const scan = await (
        await fetch('/api/agents/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: '{}',
        })
      ).json(),
      agent = scan.agents.find(
        (agent: { agentId: string }) => agent.agentId === 'zed',
      );
    await fetch('/api/agents/zed/integrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        expectedRevision: 0,
        fingerprint: agent.fingerprint,
        confirmConfigurationChange: true,
      }),
    });
  }, session.csrfToken);
  await page
    .getByLabel(
      'I approve the listed user-file changes and private backups. Existing agents may require reconnect/approval.',
    )
    .check();
  await page
    .getByTestId('integration-warp')
    .getByRole('button', { name: '1-Click Integrate', exact: true })
    .click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Change refused or incomplete.' }),
  ).toBeVisible();
  const after = await report(page);
  expect(
    after.state.integrations.map((entry: { agentId: string }) => entry.agentId),
  ).toEqual(['zed']);
  expect(after.effects.writes).toBe(before.effects.writes + 1);
});
