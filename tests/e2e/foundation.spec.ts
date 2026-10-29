import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { emptyState, stateHash, openSafetyLedger } from '@waleed/hub-core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect } from '@playwright/test';

let child: ChildProcess;
let launchUrl: string;
let directory: string;

test.beforeAll(async () => {
  directory = await mkdtemp(
    join(
      process.env.HUB_TEST_TEMP ??
        (process.platform === 'win32' ? 'E:\\Dev\\Temp\\opencode' : tmpdir()),
      'hub-browser-',
    ),
  );
  child = fork('apps/server/dist/main.js', [], {
    env: {
      ...process.env,
      HUB_PORT: '4187',
      HUB_DATA_DIR: directory,
      HUB_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  launchUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error('Disposable hub did not start. Build the workspace first.'),
        ),
      15_000,
    );
    child.once('message', (message: { launchUrl?: string }) => {
      clearTimeout(timer);
      if (message.launchUrl) resolve(message.launchUrl);
      else reject(new Error('Missing launch URL'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Disposable hub exited before startup.'));
    });
  });
});
test.afterAll(async () => {
  if (child?.connected) {
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.send('shutdown');
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('secure bootstrap, honest empty state, keyboard profile preview/apply, reload, and responsive shell', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(launchUrl);
  await expect(
    page.getByRole('heading', {
      name: 'Your existing tools stay where they are',
    }),
  ).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:4187/');
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  expect(
    (await page.context().cookies()).find(
      (cookie) => cookie.name === 'waleed_hub_session',
    ),
  ).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  await expect(
    page.getByRole('button', { name: 'Add connector', exact: true }),
  ).toBeEnabled();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole('heading', { name: 'Connectors', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/foundation-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create profile', exact: true })
    .click();
  await expect(page.getByLabel('Profile name')).toBeFocused();
  const markup = '<img src=x onerror=alert(1)>';
  await page.getByLabel('Profile name').fill(markup);
  await page
    .getByLabel('Description')
    .fill('Synthetic browser fixture. No external effects.');
  await page
    .getByRole('button', { name: 'Preview changes', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Review your changes' }),
  ).toBeVisible();
  await expect(
    page.getByText('No Docker profile or agent configuration will change.'),
  ).toBeVisible();
  expect(await page.locator('dialog img').count()).toBe(0);
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let observeRefresh!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    observeRefresh = resolve;
  });
  await page.route('**/api/profiles', async (route) => {
    observeRefresh();
    await refreshGate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Apply local change' }).click();
  try {
    await refreshing;
    await expect(
      page.getByRole('button', { name: 'Done', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Close dialog', exact: true }),
    ).toBeDisabled();
  } finally {
    releaseRefresh();
  }
  await expect(
    page.getByRole('heading', { name: 'Profile created' }),
  ).toBeVisible();
  await page.unroute('**/api/profiles');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Create profile', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('heading', { name: markup, exact: true }),
  ).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Connectors', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: markup, exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Create profile', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create profile', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  if (process.platform === 'win32') {
    await expect(
      page.getByRole('button', { name: 'Scan Installed Agents', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Find your installed agents',
        exact: true,
      }),
    ).toBeVisible();
    // Visiting Agents must not scan or modify real user files automatically.
    await expect(page.locator('[data-testid^="integration-"]')).toHaveCount(0);
  } else {
    await expect(
      page.getByText('Adapter pending', { exact: true }),
    ).toHaveCount(8);
  }
  const marker = 'SYNTHETIC-PRIVATE-BROWSER-PAYLOAD';
  const refused = await page.request.post(
    'http://127.0.0.1:4187/api/operations/preview?token=' + marker,
    {
      headers: {
        origin: 'https://untrusted.example.test',
        authorization: 'Bearer ' + marker,
      },
      data: { name: marker },
    },
  );
  expect(refused.status()).toBe(403);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Security refusals', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'origin denied', exact: true }),
  ).toBeVisible();
  const safetyText = await readFile(join(directory, 'safety.json'), 'utf8');
  expect(safetyText).not.toContain(marker);
  expect(safetyText).not.toContain(markup);
  expect(JSON.parse(safetyText).operations[0].phase).toBe('committed');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/safety-activity-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});

test('an unlaunched browser cannot see inventory', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/');
  await expect(
    page.getByRole('heading', { name: 'Unable to load this workspace' }),
  ).toBeVisible();
  expect(
    (await page.request.get('http://127.0.0.1:4187/api/profiles')).status(),
  ).toBe(401);
});

test('source-mode server starts on Node 24 and releases its writer lock on shutdown', async () => {
  const sourceDirectory = await mkdtemp(
    join(
      process.env.HUB_TEST_TEMP ??
        (process.platform === 'win32' ? 'E:\\Dev\\Temp\\opencode' : tmpdir()),
      'hub-source-',
    ),
  );
  const source = fork('apps/server/src/main.ts', [], {
    execArgv: ['--conditions=development', '--import', 'tsx'],
    env: {
      ...process.env,
      HUB_PORT: '4188',
      HUB_DATA_DIR: sourceDirectory,
      HUB_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Source-mode startup timed out.')),
        15_000,
      );
      source.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      source.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Source-mode startup failed.'));
      });
    });
    expect((await fetch('http://127.0.0.1:4188/health')).status).toBe(200);
  } finally {
    if (source.connected) {
      const exited = new Promise<void>((resolve) =>
        source.once('exit', () => resolve()),
      );
      source.send('shutdown');
      await exited;
    }
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(sourceDirectory)).not.toContain('writer.lock');
    expect(await readdir(sourceDirectory)).not.toContain('safety.lock');
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test('restart reconciliation preserves drifted state and disables further local changes', async ({
  page,
}) => {
  const isolated = await mkdtemp(
    join(
      process.env.HUB_TEST_TEMP ??
        (process.platform === 'win32' ? 'E:\\Dev\\Temp\\opencode' : tmpdir()),
      'hub-recovery-browser-',
    ),
  );
  const before = emptyState();
  const expected = { ...emptyState(), revision: 1 };
  const current = JSON.stringify({ ...emptyState(), revision: 9 });
  await writeFile(join(isolated, 'state.json'), current);
  const ledger = await openSafetyLedger(isolated);
  await ledger.prepare({
    id: randomUUID(),
    operation: 'create_profile',
    targetId: randomUUID(),
    expectedRevision: 0,
    beforeHash: stateHash(before),
    afterHash: stateHash(expected),
    phase: 'prepared',
    reason: 'none',
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  });
  await ledger.close();
  const server = fork('apps/server/dist/main.js', [], {
    env: {
      ...process.env,
      HUB_PORT: '4189',
      HUB_DATA_DIR: isolated,
      HUB_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Recovery fixture startup timed out.')),
        15_000,
      );
      server.once('message', (message: { launchUrl?: string }) => {
        clearTimeout(timer);
        if (message.launchUrl) resolve(message.launchUrl);
        else reject(new Error('Missing recovery launch URL.'));
      });
      server.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Recovery fixture exited before launch.'));
      });
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(url);
    await expect(
      page.getByRole('heading', {
        name: 'Recovery review required',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Create profile', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', {
        name: 'Create your first profile',
        exact: true,
      }),
    ).toBeDisabled();
    const response = await page.request.get(
      'http://127.0.0.1:4189/api/recovery',
    );
    expect(await response.json()).toMatchObject({
      blocked: true,
      operations: [
        expect.objectContaining({
          phase: 'needs_review',
          reason: 'state_drift',
        }),
      ],
    });
    expect(await readFile(join(isolated, 'state.json'), 'utf8')).toBe(current);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: 'test-results/safety-recovery-390.png',
      fullPage: true,
    });
  } finally {
    if (server.connected) {
      const exited = new Promise<void>((resolve) =>
        server.once('exit', () => resolve()),
      );
      server.send('shutdown');
      await exited;
    }
    await rm(isolated, { recursive: true, force: true });
  }
});
