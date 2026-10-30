import { fork, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { createServer } from 'node:net';
let server: ChildProcess;
let origin = '';
test.beforeEach(async ({ page }) => {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error();
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  origin = `http://127.0.0.1:${port}`;
  server = fork('tests/fixtures/adoption-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const launch = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Build before starting the Smart Paste fixture.')),
      15_000,
    );
    server.once('message', (message: { launchUrl: string }) => {
      clearTimeout(timer);
      resolve(message.launchUrl);
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Smart Paste fixture exited.'));
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
const smartLabel = 'URL, npx/uvx command, Docker image/run command, or JSON';
const optLabel =
  'I opt in to unencrypted local HTTP for this exact loopback endpoint and port.';
test('Smart URL rejects LAN HTTP, requires opt-in again after endpoint edits, and verifies a real loopback MCP only on request', async ({
  page,
}, testInfo) => {
  const initial = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(smartLabel, { exact: true })
    .fill('http://192.168.1.2:8080/mcp');
  await expect(
    dialog.getByRole('button', { name: 'Review detected input', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel(smartLabel, { exact: true })
    .fill(initial.localEndpoint);
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: /Local HTTP endpoint detected/ }),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Review detected input', exact: true })
    .click();
  await expect(dialog.getByLabel(smartLabel, { exact: true })).toHaveValue('');
  const url = dialog.getByLabel('MCP endpoint URL', { exact: true }),
    optIn = dialog.getByLabel(optLabel, { exact: true });
  await expect(url).toHaveValue(initial.localEndpoint);
  await expect(optIn).not.toBeChecked();
  await expect(
    dialog.getByRole('button', { name: 'Save MCP', exact: true }),
  ).toBeDisabled();
  await optIn.check();
  const approval = dialog.getByLabel(/I trust this exact executable/);
  await approval.check();
  await url.fill(initial.localEndpoint.replace('127.0.0.1', 'localhost'));
  await expect(optIn).not.toBeChecked();
  await expect(approval).not.toBeChecked();
  await expect(
    dialog.getByRole('button', { name: 'Save MCP', exact: true }),
  ).toBeDisabled();
  await optIn.check();
  await approval.check();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`task6-local-opt-in-${width}.png`),
      fullPage: true,
    });
  }
  await dialog.getByRole('button', { name: 'Save MCP', exact: true }).click();
  await expect(dialog.getByText(/MCP definition saved/)).toBeVisible();
  let report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.localMethods).toEqual([]);
  expect(report.state.connectors[0]).toMatchObject({
    localHttpOptIn: true,
    executionMode: 'remote',
  });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const row = page.getByTestId(`connector-${report.state.connectors[0].id}`);
  await row.getByTestId('connector-toggle').click();
  await row
    .getByRole('button', { name: 'Test capabilities', exact: true })
    .click();
  await expect(row.getByText(/connected · MCP discovery only/)).toBeVisible();
  report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.localMethods).toContain('initialize');
  expect(report.localMethods).not.toContain('tools/call');
});
for (const item of [
  {
    source: 'npx -y @modelcontextprotocol/server-postgres@0.1.0 --read-only',
    type: 'npx',
    name: '@modelcontextprotocol/server-postgres',
    version: '0.1.0',
    entry: 'mcp-server-postgres',
    args: ['--read-only'],
  },
  {
    source: 'uvx mcp-server-git==1.2.0 "C:\\Synthetic Repo"',
    type: 'uvx',
    name: 'mcp-server-git',
    version: '1.2.0',
    entry: 'mcp-server-git',
    args: ['C:\\Synthetic Repo'],
  },
])
  test(`Smart ${item.type} pre-fills an exact package and literal args without installing or approving it`, async ({
    page,
  }) => {
    await page
      .getByRole('button', { name: 'Add Manual MCP', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(smartLabel, { exact: true }).fill(item.source);
    await dialog
      .getByRole('button', { name: 'Review detected input', exact: true })
      .click();
    await expect(
      dialog.getByLabel('Connection type', { exact: true }),
    ).toHaveValue(item.type);
    await expect(
      dialog.getByLabel('Package name', { exact: true }),
    ).toHaveValue(item.name);
    await expect(
      dialog.getByLabel('Exact package version', { exact: true }),
    ).toHaveValue(item.version);
    await expect(
      dialog.getByLabel('Package executable name (optional)', { exact: true }),
    ).toHaveValue(item.entry);
    await expect(
      dialog.getByLabel('Arguments (JSON array, no shell expansion)', {
        exact: true,
      }),
    ).toHaveValue(JSON.stringify(item.args));
    await expect(
      dialog.getByLabel(/I trust this exact executable/),
    ).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Save MCP', exact: true }).click();
    await expect(dialog.getByText(/MCP definition saved/)).toBeVisible();
    const report = await (
      await page.request.get(`${origin}/api/fixture-report`)
    ).json();
    expect(report.state.connectors[0]).toMatchObject({
      executionMode: 'package',
      trustApproval: null,
      package: {
        manager: item.type === 'npx' ? 'npm' : 'uvx',
        name: item.name,
        version: item.version,
        entryPoint: item.entry,
      },
      arguments: item.args,
    });
    expect(report.localMethods).toEqual([]);
  });
test('Smart Docker extracts private env input into write-only fields and refuses unsupported run flags', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(smartLabel, { exact: true })
    .fill('docker run --privileged synthetic/mcp:1.2.3');
  await expect(
    dialog.getByRole('button', { name: 'Review detected input', exact: true }),
  ).toBeDisabled();
  const value = 'SYNTHETIC-SMART-DOCKER-PRIVATE';
  await dialog
    .getByLabel(smartLabel, { exact: true })
    .fill(
      `docker run --rm -i -e TOKEN="${value}" -p 3000:8080 synthetic/mcp:1.2.3 --mode read`,
    );
  expect(await dialog.getByRole('status').textContent()).not.toContain(value);
  await dialog
    .getByRole('button', { name: 'Review detected input', exact: true })
    .click();
  await expect(dialog.getByLabel('Docker image', { exact: true })).toHaveValue(
    'synthetic/mcp:1.2.3',
  );
  await expect(
    dialog.getByLabel('Loopback ports (JSON)', { exact: true }),
  ).toHaveValue('[{"host":3000,"container":8080}]');
  await expect(
    dialog.getByLabel('Protected environment values (write-only JSON)', {
      exact: true,
    }),
  ).toHaveValue(JSON.stringify({ TOKEN: value }));
  await expect(dialog.getByLabel(smartLabel, { exact: true })).toHaveValue('');
  await expect(
    dialog.getByLabel(/I trust this exact executable/),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.state.connectors).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
test('Smart JSON creates a sanitized private draft, with no local definition until checkbox confirmation and preview update', async ({
  page,
}) => {
  const initial = await (
      await page.request.get(`${origin}/api/fixture-report`)
    ).json(),
    secret = 'SYNTHETIC-SMART-JSON-PRIVATE';
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(smartLabel, { exact: true }).fill(
    JSON.stringify({
      mcpServers: {
        Local: {
          url: initial.localEndpoint,
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    }),
  );
  const response = page.waitForResponse((response) =>
    response.url().endsWith('/api/imports/preview'),
  );
  await dialog
    .getByRole('button', { name: 'Review detected input', exact: true })
    .click();
  const draft = await (await response).json();
  expect(draft.entries[0].definition).toBe(null);
  expect(draft.selectionReady).toBe(false);
  await expect(
    dialog.getByRole('heading', {
      name: 'Review import configuration',
      exact: true,
    }),
  ).toBeVisible();
  expect(await dialog.textContent()).not.toContain(secret);
  await dialog
    .getByLabel(/I opt in to unencrypted local HTTP for entry 1/)
    .check();
  const confirmed = page.waitForResponse((response) =>
    response.url().endsWith('/selection'),
  );
  await dialog
    .getByRole('button', { name: 'Update preview', exact: true })
    .click();
  expect((await (await confirmed).json()).entries[0].definition).toMatchObject({
    localHttpOptIn: true,
    endpoint: initial.localEndpoint,
  });
  await dialog.getByLabel('Bind to Synthetic profile', { exact: true }).check();
  await dialog
    .getByLabel(
      'I confirm importing the reviewed definitions, protected credentials and profile membership.',
      { exact: true },
    )
    .check();
  await dialog
    .getByRole('button', { name: 'Apply protected import', exact: true })
    .click();
  await expect(dialog.getByText(/Import completed/)).toBeVisible();
  const report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.state.connectors[0]).toMatchObject({
    localHttpOptIn: true,
    trustApproval: null,
  });
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(report.buffersCleared).toBe(true);
  expect(report.localMethods).toEqual([]);
});
test('Smart Paste in the import dialog detects a quoted package command without an automatic request', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(smartLabel, { exact: true })
    .fill('uvx mcp-server-git==1.2.0 "A B"');
  await expect(
    dialog.getByRole('status').filter({ hasText: /Python package detected/ }),
  ).toBeVisible();
  let report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.state.connectors).toEqual([]);
  expect(report.localMethods).toEqual([]);
  await dialog
    .getByRole('button', { name: 'Review detected input', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', {
      name: 'Review import configuration',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel('Entry 1 exact version', { exact: true }),
  ).toHaveValue('1.2.0');
  await dialog
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
  report = await (
    await page.request.get(`${origin}/api/fixture-report`)
  ).json();
  expect(report.state.connectors).toEqual([]);
});
