import { fork, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { privateMarker } from '../fixtures/discovery.js';

let server: ChildProcess;
async function launch(scenario: 'healthy' | 'docker_down' | 'slow') {
  server = fork('tests/fixtures/discovery-server.mjs', [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, HUB_PORT: '4190', HUB_TEST_SCENARIO: scenario },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            'Synthetic discovery server did not start. Build the workspace first.',
          ),
        ),
      15_000,
    );
    server.once('message', (message: { launchUrl?: string }) => {
      clearTimeout(timer);
      if (message.launchUrl) resolve(message.launchUrl);
      else reject(new Error('Synthetic launch was missing.'));
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Synthetic discovery server exited.'));
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

test('explicit discovery displays sanitized observations and a non-applicable pilot preview', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(await launch('healthy'));
  await expect(
    page.getByText(
      'Synthetic discovery fixture — not your installed environment.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    (
      await (
        await page.request.get('http://127.0.0.1:4190/api/discovery')
      ).json()
    ).checkedAt,
  ).toBeNull();
  await page
    .getByRole('button', { name: 'Discover environment', exact: true })
    .click();
  await expect(
    page.getByText('Scan succeeded · complete', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/8\/8 CLI targets found/)).toBeVisible();
  await page
    .getByText('Review existing pilot — read-only adoption preview', {
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Apply adoption', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('fixture-remote', { exact: true })).toBeVisible();
  await expect(page.getByText('fixture-image', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Chrome DevTools', { exact: true }),
  ).toBeVisible();
  const snapshot = await (
    await page.request.get('http://127.0.0.1:4190/api/discovery')
  ).json();
  expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
  expect(snapshot.agents).toHaveLength(8);
  expect(
    snapshot.agents.every(
      (agent: { registered: boolean | null }) => agent.registered === null,
    ),
  ).toBe(true);
  expect(
    await (
      await page.request.get('http://127.0.0.1:4190/api/connectors')
    ).json(),
  ).toEqual({ connectors: [], observations: [] });
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/discovery-preview-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Adapter pending', { exact: true })).toHaveCount(
    8,
  );
  await expect(
    page.getByText(/1\.2\.3 \(manifest\) · user bindings: pending/),
  ).toHaveCount(2);
  await page.screenshot({
    path: 'test-results/discovery-agents-390.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test('Docker stopped remains a useful degraded view without erasing agent/native observations', async ({
  page,
}) => {
  await page.goto(await launch('docker_down'));
  await page
    .getByRole('button', { name: 'Discover environment', exact: true })
    .click();
  await expect(
    page.getByText('Scan succeeded · complete', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Start Docker Desktop and wait for its engine, then scan again.',
      { exact: true },
    ),
  ).toBeVisible();
  const snapshot = await (
    await page.request.get('http://127.0.0.1:4190/api/discovery')
  ).json();
  expect(snapshot.docker.state).toBe('unavailable');
  expect(
    snapshot.agents.every((agent: { detected: boolean }) => agent.detected),
  ).toBe(true);
  expect(snapshot.pilot.candidates).toEqual([
    expect.objectContaining({ executionMode: 'native' }),
  ]);
  await page.screenshot({
    path: 'test-results/discovery-docker-unavailable.png',
    fullPage: true,
  });
});

test('a running scan can be cancelled without publishing partial discovery', async ({
  page,
}) => {
  await page.goto(await launch('slow'));
  await page
    .getByRole('button', { name: 'Discover environment', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cancel scan', exact: true }).click();
  await expect(page.getByText(/^Scan cancelled/)).toBeVisible();
  expect(
    (
      await (
        await page.request.get('http://127.0.0.1:4190/api/discovery')
      ).json()
    ).checkedAt,
  ).toBeNull();
  await expect(
    page.getByRole('button', { name: 'Discover environment', exact: true }),
  ).toBeEnabled();
});
