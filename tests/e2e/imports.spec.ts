import { fork, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import type { ImportPreview } from '@waleed/contracts';
import { importSecret, mixedImport } from '../fixtures/imports.js';

let server: ChildProcess;
async function launch() {
  server = fork('tests/fixtures/discovery-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: '4192', HUB_TEST_SCENARIO: 'healthy' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error('Synthetic import server did not start. Build first.'),
        ),
      15_000,
    );
    server.once('message', (message: { launchUrl?: string }) => {
      clearTimeout(timer);
      if (message.launchUrl) resolve(message.launchUrl);
      else reject(new Error('Synthetic launch missing.'));
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Synthetic import server exited.'));
    });
  });
}
async function paste(page: Page, config: unknown) {
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  await expect(
    page.getByLabel('Configuration JSON', { exact: true }),
  ).toBeFocused();
  await page
    .getByLabel('Configuration JSON', { exact: true })
    .fill(typeof config === 'string' ? config : JSON.stringify(config));
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/imports/preview') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Preview configuration', exact: true })
    .click();
  return response;
}
async function mutate(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const session = (await (await fetch('/api/session')).json()) as {
        csrfToken: string;
      };
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        value: (await response.json()) as Record<string, unknown>,
      };
    },
    { path, body },
  );
}
test.afterEach(async () => {
  if (server?.connected) {
    const exited = new Promise<void>((resolve) =>
      server.once('exit', () => resolve()),
    );
    server.send('shutdown');
    await exited;
  }
});

test('paste/select/review/export is sanitized, responsive, keyboard accessible and cancel clears the draft', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(await launch());
  const response = await paste(page, mixedImport);
  const preview = (await response.json()) as ImportPreview;
  await expect(
    page.getByRole('heading', {
      name: 'Review import configuration',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Apply import (unavailable)',
      exact: true,
    }),
  ).toBeDisabled();
  expect(await page.locator('dialog').innerText()).not.toContain(importSecret);
  expect(
    await page.locator('dialog textarea, dialog input[type=password]').count(),
  ).toBe(0);
  expect(preview.entries).toHaveLength(3);
  expect(JSON.stringify(preview)).not.toContain(importSecret);
  await page
    .getByText('Sanitized normalized definition', { exact: true })
    .first()
    .click();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('dialog')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/import-review-${width}.png`,
      fullPage: true,
    });
  }
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export sanitized preview', exact: true })
    .click();
  const artifact = await download;
  const path = await artifact.path();
  expect(path).not.toBeNull();
  const exported = await readFile(path!, 'utf8');
  expect(exported).not.toContain(importSecret);
  expect(JSON.parse(exported)).toMatchObject({
    applySupported: false,
    effects: { registryWrites: false },
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Add connector', exact: true }),
  ).toBeFocused();
  expect(
    (
      await page.request.get(`http://127.0.0.1:4192/api/imports/${preview.id}`)
    ).status(),
  ).toBe(404);
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  await expect(
    page.getByLabel('Configuration JSON', { exact: true }),
  ).toHaveValue('');
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  expect(
    (
      await (
        await page.request.get('http://127.0.0.1:4192/api/discovery')
      ).json()
    ).checkedAt,
  ).toBeNull();
  expect(
    await (
      await page.request.get('http://127.0.0.1:4192/api/connectors')
    ).json(),
  ).toEqual({ connectors: [], observations: [] });
  expect(errors).toEqual([]);
});

test('partial configurations and duplicate name/ID conflicts require explicit selection decisions', async ({
  page,
}) => {
  await page.goto(await launch());
  await paste(page, {
    servers: {
      Bad: { command: 'tool', cwd: 'unsupported' },
      One: { name: 'Duplicate', id: 'duplicate', command: 'tool' },
      Two: { name: 'Duplicate', id: 'duplicate', command: 'tool' },
    },
  });
  await expect(
    page.getByText('unsupported fields: cwd', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Review blocked: invalid selection, conflicts/),
  ).toBeVisible();
  await page.getByLabel('Include entry 1', { exact: true }).uncheck();
  const markup = '<img src=x onerror=alert(1)>';
  await page.getByLabel('Entry 3 name', { exact: true }).fill(markup);
  await page.getByLabel('Entry 3 identifier', { exact: true }).fill('renamed');
  await expect(
    page.getByRole('button', { name: 'Export sanitized preview', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Update preview', exact: true })
    .click();
  await expect(
    page.getByText(
      'Selection is valid for review. Local save requires a separate preview; private import values stay memory-only.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  expect(await page.locator('dialog img').count()).toBe(0);
  await expect(
    page.getByRole('heading', { name: `Entry 3: ${markup}`, exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: 'test-results/import-conflicts-resolved.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
});

test('guided native forms preserve inert argument arrays and clear write-only environment inputs', async ({
  page,
}) => {
  await page.goto(await launch());
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  await page.getByLabel('Native command', { exact: true }).check();
  await page
    .getByLabel('Connector name', { exact: true })
    .fill('Native fixture');
  await page.getByRole('button', { name: 'Use uvx', exact: true }).click();
  const args = [
    'synthetic==1.2.3',
    '--CaseSensitive',
    '$(not-executed); & inert',
  ];
  await page
    .getByLabel('Arguments (JSON array)', { exact: true })
    .fill(JSON.stringify(args));
  await page
    .getByLabel('Environment values (write-only JSON object)', { exact: true })
    .fill(JSON.stringify({ TOKEN: importSecret }));
  const response = page.waitForResponse((response) =>
    response.url().endsWith('/api/imports/preview'),
  );
  await page
    .getByRole('button', { name: 'Preview configuration', exact: true })
    .click();
  const preview = (await (await response).json()) as ImportPreview;
  expect(preview.entries[0]?.definition).toMatchObject({
    executionMode: 'package',
    package: {
      manager: 'uvx',
      name: 'synthetic',
      version: '1.2.3',
      entryPoint: 'synthetic',
    },
    arguments: args.slice(1),
    trustApproval: null,
  });
  expect(await page.locator('dialog').innerText()).not.toContain(importSecret);
  await expect(page.getByText(/package download/).first()).toBeVisible();
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
});

test('invalid pasted programs clear inputs and show a non-reflecting inline error', async ({
  page,
}) => {
  await page.goto(await launch());
  await paste(page, `Write-Output ${importSecret}`);
  await expect(page.getByRole('alert')).toContainText(
    'Use bounded JSON configuration',
  );
  expect(await page.getByRole('alert').innerText()).not.toContain(importSecret);
  await expect(
    page.getByLabel('Configuration JSON', { exact: true }),
  ).toHaveValue('');
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.screenshot({
    path: 'test-results/import-invalid-input.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
});

test('registry changes invalidate and discard a private preview, rather than silently rebasing it', async ({
  page,
}) => {
  await page.goto(await launch());
  const response = await paste(page, mixedImport);
  const preview = (await response.json()) as ImportPreview;
  const localPreview = await mutate(page, '/api/operations/preview', {
    kind: 'create_profile',
    name: 'Revision change fixture',
    description: '',
    expectedRevision: 0,
  });
  const job = await mutate(page, '/api/operations/apply', {
    previewId: localPreview.value.id,
  });
  expect(job.status).toBe(202);
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `http://127.0.0.1:4192/api/jobs/${String(job.value.id)}`,
            )
          ).json()
        ).state,
    )
    .toBe('succeeded');
  await page
    .getByRole('button', { name: 'Update preview', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Inventory changed');
  await expect(
    page.getByLabel('Configuration JSON', { exact: true }),
  ).toHaveValue('');
  expect(
    (
      await page.request.get(`http://127.0.0.1:4192/api/imports/${preview.id}`)
    ).status(),
  ).toBe(404);
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
});

test('guided HTTPS preview reports invalid URLs without contacting them', async ({
  page,
}) => {
  await page.goto(await launch());
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4192'))
      external.push(request.url());
  });
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  await page
    .getByRole('radio', { name: 'Remote endpoint', exact: true })
    .check();
  await page
    .getByLabel('Connector name', { exact: true })
    .fill('Endpoint fixture');
  await page
    .locator('#import-endpoint')
    .fill('https://example.test/mcp?token=' + importSecret);
  await page
    .getByRole('button', { name: 'Preview configuration', exact: true })
    .click();
  await expect(
    page.getByText('invalid endpoint: url', { exact: true }),
  ).toBeVisible();
  expect(await page.locator('dialog').innerText()).not.toContain(importSecret);
  expect(external).toEqual([]);
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
});

test('failed discard is explicit and can be retried; browser expiry removes the review', async ({
  page,
}) => {
  await page.goto(await launch());
  await paste(page, mixedImport);
  await page.route('**/api/imports/*/cancel', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Synthetic discard failure.' }),
    }),
  );
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Server discard could not be confirmed',
  );
  expect(await page.locator('dialog').innerText()).not.toContain(importSecret);
  await page.unroute('**/api/imports/*/cancel');
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await page.clock.install();
  await paste(page, mixedImport);
  await page.clock.fastForward(5 * 60_000 + 1000);
  await expect(page.getByRole('alert')).toContainText('Private draft expired');
  await expect(
    page.getByLabel('Configuration JSON', { exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Export sanitized preview', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Cancel and discard', exact: true })
    .click();
});
