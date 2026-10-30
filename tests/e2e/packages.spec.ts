import { fork, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import type { ImportPreview } from '@waleed/contracts';

let server: ChildProcess;
async function launch() {
  server = fork('tests/fixtures/discovery-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: '4193', HUB_TEST_SCENARIO: 'healthy' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error('Synthetic package server did not start. Build first.'),
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
      reject(new Error('Synthetic package server exited.'));
    });
  });
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

// Synthetic identifiers only. No value of a credential, a token or a secret
// ever appears in this file or in a request body.
const RESOLVE_JOB = '11111111-1111-4111-8111-111111111111';
const INSTALL_JOB = '22222222-2222-4222-8222-222222222222';
const PREVIEW_ID = '33333333-3333-4333-8333-333333333333';
const LOCK_HASH =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const INTEGRITY = `sha512-${'B'.repeat(86)}==`;

function preview() {
  return {
    previewId: PREVIEW_ID,
    name: 'demo-mcp',
    version: '1.2.0',
    description: 'Synthetic demo package for the browser test.',
    integrity: INTEGRITY,
    lockHash: LOCK_HASH,
    packageCount: 3,
    bundledCount: 1,
    unpackedSize: 1048576,
    releasedAt: '2026-01-02T00:00:00.000Z',
    entries: [
      { entry: 'demo-mcp', entryPath: 'bin/demo-mcp.js' },
      { entry: 'demo-mcp-alt', entryPath: 'bin/demo-mcp-alt.js' },
    ],
    warnings: ['install_scripts', 'recent_release'],
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}
function job(overrides: Record<string, unknown>) {
  return {
    id: RESOLVE_JOB,
    kind: 'resolve',
    state: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    phase: 'resolving',
    progress: { downloadedBytes: 0, packages: 0 },
    error: null,
    preview: null,
    result: null,
    ...overrides,
  };
}
async function fakePackageApi(
  page: Page,
  options: { failResolve?: boolean } = {},
) {
  const state: {
    resolvePolls: number;
    installPolls: number;
    installBody: Record<string, unknown> | null;
  } = { resolvePolls: 0, installPolls: 0, installBody: null };
  const answer = async (
    route: Parameters<Parameters<Page['route']>[1]>[0],
    body: unknown,
    status = 200,
  ) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  };
  await page.route('**/api/packages/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/packages/resolve') {
      await answer(route, job({}), 202);
      return;
    }
    if (path === '/api/packages/install') {
      state.installBody = request.postDataJSON() as Record<string, unknown>;
      await answer(
        route,
        job({
          id: INSTALL_JOB,
          kind: 'install',
          phase: 'downloading',
          progress: { downloadedBytes: 2097152, packages: 3 },
        }),
        202,
      );
      return;
    }
    if (path === '/api/packages/replace') {
      await answer(
        route,
        job({ id: INSTALL_JOB, kind: 'replace', phase: 'downloading' }),
        202,
      );
      return;
    }
    if (path === `/api/packages/jobs/${RESOLVE_JOB}`) {
      state.resolvePolls += 1;
      if (options.failResolve) {
        await answer(
          route,
          job({
            state: 'failed',
            phase: 'complete',
            error: 'version_not_found',
            completedAt: '2026-01-01T00:00:05.000Z',
          }),
        );
        return;
      }
      if (state.resolvePolls === 1) {
        await answer(route, job({}));
        return;
      }
      await answer(
        route,
        job({
          state: 'succeeded',
          phase: 'complete',
          preview: preview(),
          completedAt: '2026-01-01T00:00:05.000Z',
        }),
      );
      return;
    }
    if (path === `/api/packages/jobs/${INSTALL_JOB}`) {
      state.installPolls += 1;
      if (state.installPolls === 1) {
        await answer(
          route,
          job({
            id: INSTALL_JOB,
            kind: 'install',
            phase: 'downloading',
            progress: { downloadedBytes: 2097152, packages: 3 },
          }),
        );
        return;
      }
      await answer(
        route,
        job({
          id: INSTALL_JOB,
          kind: 'install',
          state: 'succeeded',
          phase: 'complete',
          result: { connectorId: 'demo-mcp', outcome: 'saved' },
          completedAt: '2026-01-01T00:00:08.000Z',
        }),
      );
      return;
    }
    if (path.endsWith('/cancel')) {
      await answer(route, job({ state: 'cancelled', error: 'cancelled' }));
      return;
    }
    if (path.startsWith('/api/packages/verify/')) {
      await answer(route, {
        connectorId: path.split('/').pop(),
        result: 'verified',
      });
      return;
    }
    await answer(route, { message: 'Unknown synthetic package route.' }, 404);
  });
  return state;
}

test('the managed npm flow installs a reviewed package and never approves it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(await launch());
  const state = await fakePackageApi(page);
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  await page.getByLabel('Connection type', { exact: true }).selectOption('npm');
  await page.getByLabel('Connector name', { exact: true }).fill('Demo MCP');
  await page.getByLabel('Package name', { exact: true }).fill('demo-mcp');
  await page.getByLabel('Version (optional)', { exact: true }).fill('^1.0.0');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'demo-mcp@1.2.0', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Command to run', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(
    page.getByText('This package has install scripts', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('This release is younger than 7 days', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(/node\.exe --no-global-search-paths/),
  ).toBeVisible();
  const install = page.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  await page.getByRole('radio', { name: /bin\/demo-mcp-alt\.js/ }).check();
  await expect(install).toBeDisabled();
  await page.getByLabel(/This package has install scripts/).check();
  await expect(install).toBeDisabled();
  await page.getByLabel(/This release is younger than 7 days/).check();
  await expect(install).toBeEnabled();
  const envField = page.getByLabel(
    'Protected environment values (write-only JSON)',
    { exact: true },
  );
  // A broken value is refused and wiped instead of kept in the form.
  await envField.fill('{"LOG_LEVEL":');
  await install.click();
  await expect(page.getByRole('alert')).toContainText(
    'Use a JSON object of environment values.',
  );
  await expect(envField).toHaveValue('');
  await envField.fill('{"LOG_LEVEL":"debug"}');
  for (const width of [1440, 390]) {
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
  }
  await page.screenshot({
    path: 'test-results/package-preview.png',
    fullPage: true,
  });
  await install.click();
  await expect(page.getByText(/Saving is not approval/)).toBeVisible();
  await expect(
    page.getByText(/Installed demo-mcp@1\.2\.0 as connector demo-mcp\./),
  ).toBeVisible();
  expect(state.installBody).toEqual({
    previewId: PREVIEW_ID,
    entry: 'demo-mcp-alt',
    acknowledgedWarnings: ['install_scripts', 'recent_release'],
    connectorName: 'Demo MCP',
    arguments: [],
    env: { LOG_LEVEL: 'debug' },
  });
  // The submitted value is gone from the page once the install settles.
  expect(await page.content()).not.toContain('debug');
  expect(Object.keys(state.installBody ?? {})).not.toContain('package');
  expect(await page.locator('dialog').innerText()).not.toContain('npmrc');
  await page.screenshot({
    path: 'test-results/package-installed.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test('a refused lookup shows its sanitized sentence and keeps the form', async ({
  page,
}) => {
  await page.goto(await launch());
  await fakePackageApi(page, { failResolve: true });
  await page
    .getByRole('button', { name: 'Add Manual MCP', exact: true })
    .click();
  await page.getByLabel('Connection type', { exact: true }).selectOption('npm');
  await page.getByLabel('Package name', { exact: true }).fill('demo-mcp');
  // The connector name is asked before the lookup, not after the preview.
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Enter a connector name.',
  );
  await page.getByLabel('Connector name', { exact: true }).fill('Demo MCP');
  await page.getByLabel('Version (optional)', { exact: true }).fill('9.9.9');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'No release matches that version, range or tag.',
  );
  await expect(page.getByLabel('Package name', { exact: true })).toHaveValue(
    'demo-mcp',
  );
  await page.screenshot({
    path: 'test-results/package-version-not-found.png',
    fullPage: true,
  });
});

test('an import proposal is listed separately and opens the package flow', async ({
  page,
}) => {
  await page.goto(await launch());
  await fakePackageApi(page);
  const previewResponse = {
    id: '44444444-4444-4444-8444-444444444444',
    expectedRevision: 0,
    expiresAt: '2099-01-01T00:00:00.000Z',
    format: 'mcpServers',
    entries: [
      {
        key: 'demo-mcp',
        selected: false,
        name: 'Demo MCP',
        id: 'demo-mcp',
        definition: null,
        packageProposal: {
          name: 'demo-mcp',
          version: null,
          requestedVersion: '^1.0.0',
          arguments: ['--stdio'],
          envNames: ['LOG_LEVEL'],
        },
        issues: [],
        warnings: [],
        conflicts: [],
      },
    ],
    secretReferences: [],
    selectionReady: true,
    applySupported: false,
    blockers: [],
    effects: {
      scope: 'preview_only',
      files: [],
      affectedAgents: [],
      registryWrites: false,
      secretStoreWrites: false,
      processes: 0,
      networkRequests: 0,
      proposedConnectorCount: 0,
      downloads: [],
      permissions: [],
    },
  } satisfies ImportPreview;
  await page.route('**/api/imports/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(previewResponse),
    }),
  );
  await page
    .getByRole('button', { name: 'Add connector', exact: true })
    .click();
  await page
    .getByLabel('Configuration JSON', { exact: true })
    .fill('{"mcpServers":{"demo":{"command":"npx","args":["-y","demo-mcp"]}}}');
  await page
    .getByRole('button', { name: 'Preview configuration', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Package proposals', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('^1.0.0 (resolved at Look up)')).toBeVisible();
  await expect(page.getByText('Will ask for: LOG_LEVEL')).toBeVisible();
  await expect(page.getByText('Arguments: --stdio')).toBeVisible();
  await page.screenshot({
    path: 'test-results/package-proposal.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Install demo-mcp', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Install an npm package', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Package name', { exact: true })).toHaveValue(
    'demo-mcp',
  );
  await expect(
    page.getByLabel('Version (optional)', { exact: true }),
  ).toHaveValue('^1.0.0');
  await expect(
    page.getByText('This entry used: LOG_LEVEL. Enter their values here.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'demo-mcp@1.2.0', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Arguments (JSON array, no shell expansion)', {
      exact: true,
    }),
  ).toHaveValue('["--stdio"]');
  await expect(
    page.getByLabel('Protected environment values (write-only JSON)', {
      exact: true,
    }),
  ).toHaveValue('');
  await page.screenshot({
    path: 'test-results/package-proposal-install.png',
    fullPage: true,
  });
});
