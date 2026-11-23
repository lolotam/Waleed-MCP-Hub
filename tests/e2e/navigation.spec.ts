import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect, type Page } from '@playwright/test';

let child: ChildProcess;
let directory: string;

async function launch(): Promise<string> {
  directory = await mkdtemp(
    join(process.env.HUB_TEST_TEMP ?? tmpdir(), 'hub-navigation-'),
  );
  child = fork('apps/server/dist/main.js', [], {
    env: {
      ...process.env,
      HUB_PORT: '4195',
      HUB_DATA_DIR: directory,
      HUB_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise<string>((resolve, reject) => {
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
}
// Each test starts its own hub and a browser, and closing them is slow on a
// busy machine.
test.beforeEach(() => {
  test.setTimeout(90_000);
});
test.afterEach(async () => {
  if (child?.connected) {
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.send('shutdown');
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

const hash = (page: Page) => page.evaluate(() => window.location.hash);
const current = (page: Page) => page.locator('[aria-current="page"]');
const side = (page: Page, name: string) =>
  page.getByRole('navigation').getByRole('button', { name, exact: true });

test('every place has an address and a reload stays on it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(await launch());
  await expect(
    page.getByRole('heading', { name: 'Connectors', exact: true }),
  ).toBeVisible();
  // The launch token is gone and the first page has no address of its own.
  expect(await hash(page)).toBe('');
  await expect(current(page)).toHaveCount(1);

  await side(page, 'Agents').click();
  expect(await hash(page)).toBe('#/agents');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Agents', exact: true }),
  ).toBeVisible();
  await expect(current(page)).toContainText('Agents');

  await side(page, 'Profiles').click();
  expect(await hash(page)).toBe('#/profiles');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Profiles', exact: true }),
  ).toBeVisible();

  await side(page, 'Activity').click();
  expect(await hash(page)).toBe('#/activity/registry');
  const registry = page.getByRole('tab', {
    name: 'Registry activity',
    exact: true,
  });
  const refusals = page.getByRole('tab', {
    name: 'Security refusals',
    exact: true,
  });
  await expect(registry).toHaveAttribute('aria-selected', 'true');
  await refusals.click();
  expect(await hash(page)).toBe('#/activity/refusals');
  await page.reload();
  await expect(refusals).toHaveAttribute('aria-selected', 'true');
  await expect(current(page)).toHaveCount(1);
  await expect(current(page)).toContainText('Activity');

  await side(page, 'Settings').click();
  expect(await hash(page)).toBe('#/settings/runtime');
  await page.getByRole('tab', { name: 'Recovery', exact: true }).click();
  expect(await hash(page)).toBe('#/settings/recovery');
  await page.reload();
  await expect(
    page.getByRole('tab', { name: 'Recovery', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(current(page)).toContainText('Settings');

  await side(page, 'Connectors').click();
  expect(await hash(page)).toBe('#/connectors');
  await page.getByRole('tab', { name: 'Add', exact: true }).click();
  expect(await hash(page)).toBe('#/connectors/add/import');
  const manual = page.getByRole('link', {
    name: 'Manual MCP',
    exact: true,
  });
  await manual.click();
  expect(await hash(page)).toBe('#/connectors/add/manual');
  await expect(manual).toHaveAttribute('aria-current', 'true');
  await page.reload();
  await expect(manual).toHaveAttribute('aria-current', 'true');
  await expect(current(page)).toContainText('Connectors');
  expect(errors).toEqual([]);
});

test('Back and Forward return to the previous place', async ({ page }) => {
  await page.goto(await launch());
  await side(page, 'Profiles').click();
  await side(page, 'Activity').click();
  await page.getByRole('tab', { name: 'Security refusals' }).click();
  expect(await hash(page)).toBe('#/activity/refusals');
  await page.goBack();
  expect(await hash(page)).toBe('#/activity/registry');
  await expect(
    page.getByRole('tab', { name: 'Registry activity' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  expect(await hash(page)).toBe('#/profiles');
  await expect(current(page)).toContainText('Profiles');
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Connectors', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(current(page)).toContainText('Profiles');
});

test('the arrow keys move between the tabs', async ({ page }) => {
  await page.goto(await launch());
  await side(page, 'Activity').click();
  const registry = page.getByRole('tab', { name: 'Registry activity' });
  const refusals = page.getByRole('tab', { name: 'Security refusals' });
  await registry.focus();
  await page.keyboard.press('ArrowRight');
  await expect(refusals).toBeFocused();
  await expect(refusals).toHaveAttribute('aria-selected', 'true');
  expect(await hash(page)).toBe('#/activity/refusals');
  await page.keyboard.press('ArrowRight');
  await expect(registry).toBeFocused();
  await page.keyboard.press('End');
  await expect(refusals).toBeFocused();
  await page.keyboard.press('Home');
  await expect(registry).toBeFocused();
});

test('Skip to content focuses the main region and keeps the address', async ({
  page,
}) => {
  await page.goto(await launch());
  await side(page, 'Activity').click();
  await page.getByRole('tab', { name: 'Security refusals' }).click();
  expect(await hash(page)).toBe('#/activity/refusals');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await skip.focus();
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  expect(await hash(page)).toBe('#/activity/refusals');
  await page.reload();
  await expect(
    page.getByRole('tab', { name: 'Security refusals' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(current(page)).toContainText('Activity');
});

test('a page address shares the fragment with the launch token and the token is erased', async ({
  page,
}) => {
  const url = await launch();
  await page.goto(url.replace('#launch=', '#/profiles&launch='));
  await expect(
    page.getByRole('heading', { name: 'Profiles', exact: true }),
  ).toBeVisible();
  expect(await hash(page)).toBe('#/profiles');
  expect(page.url()).not.toContain('launch');
});

test('an unknown address opens Connectors, and a hidden tab moves to its first visible sibling', async ({
  page,
}) => {
  const url = await launch();
  // Hide the update tab the way a hub without release checks does.
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      capabilities: Record<string, boolean>;
    };
    body.capabilities.appUpdates = false;
    await route.fulfill({ response, json: body });
  });
  await page.goto(url.replace('#launch=', '#/settings/updates&launch='));
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Runtime & safeguards' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Updates' })).toHaveCount(0);
  expect(await hash(page)).toBe('#/settings/runtime');

  await page.evaluate(() => {
    window.location.hash = '#/nonsense/place';
  });
  await expect(
    page.getByRole('heading', { name: 'Connectors', exact: true }),
  ).toBeVisible();
  await expect(current(page)).toContainText('Connectors');
});

test('Appearance can be changed while the hub fails to load', async ({
  page,
}) => {
  const url = await launch();
  await page.route('**/api/bootstrap', (route) => route.abort());
  await page.goto(url.replace('#launch=', '#/settings/runtime&launch='));
  await expect(
    page.getByRole('heading', { name: 'Unable to load this workspace' }),
  ).toBeVisible();
  await page
    .getByRole('group', { name: 'Appearance', exact: true })
    .getByRole('button', { name: 'Dark', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('Settings has a Recovery tab and Activity has one tab per log', async ({
  page,
}) => {
  await page.goto(await launch());
  await side(page, 'Settings').click();
  await page.getByRole('tab', { name: 'Recovery', exact: true }).click();
  await expect(page.getByText('No unresolved operations')).toBeVisible();
  await side(page, 'Activity').click();
  await expect(
    page.getByRole('heading', { name: 'Registry activity', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Security refusals', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Security refusals' }).click();
  await expect(
    page.getByRole('heading', { name: 'Security refusals', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Registry activity', exact: true }),
  ).toHaveCount(0);
});
