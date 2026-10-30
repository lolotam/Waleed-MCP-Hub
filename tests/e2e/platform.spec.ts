import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect } from '@playwright/test';
let server: ChildProcess;
test.afterEach(async () => {
  if (server?.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      server.once('exit', () => resolve()),
    );
    if (server.connected) server.send('shutdown');
    const timer = setTimeout(() => server.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
});
for (const [platform, name, containment] of [
  ['win32', 'Windows DPAPI', 'Windows JobObject'],
  ['darwin', 'macOS Keychain', 'POSIX process groups'],
  ['linux', 'Linux Secret Service / libsecret', 'POSIX process groups'],
]) {
  test(`${name} diagnostics are lazy, explicitly checked, responsive and fail closed`, async ({
    page,
  }, testInfo) => {
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, '127.0.0.1', resolve),
    );
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error();
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    server = fork('tests/fixtures/platform-server.mjs', [], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        HUB_PORT: String(port),
        HUB_TEST_PLATFORM: platform,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const launch = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Platform fixture readiness failed')),
        15000,
      );
      server.once('message', (message: { launchUrl: string }) => {
        clearTimeout(timer);
        resolve(message.launchUrl);
      });
      server.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Platform fixture exited'));
      });
    });
    await page.goto(launch);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const section = page.getByRole('region', {
      name: 'Credential storage & containment',
      exact: true,
    });
    await expect(section).toContainText(name!);
    await expect(section).toContainText('Not checked');
    await expect(section).toContainText(containment!);
    expect(
      (
        await page.evaluate(async () =>
          (await fetch('/api/fixture/report')).json(),
        )
      ).checks,
    ).toBe(0);
    await section
      .getByRole('button', { name: 'Check credential storage', exact: true })
      .click();
    await expect(section).toContainText('Available');
    expect(
      (
        await page.evaluate(async () =>
          (await fetch('/api/fixture/report')).json(),
        )
      ).checks,
    ).toBe(1);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      await section.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`storage-${platform}-${width}.png`),
        fullPage: true,
      });
    }
    await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      await fetch('/api/fixture/lock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
        },
        body: '{}',
      });
    });
    await section
      .getByRole('button', { name: 'Check credential storage', exact: true })
      .click();
    await expect(section).toContainText(
      'Unavailable — locked, denied or missing',
    );
    await expect(section).not.toContainText('SYNTHETIC-PRIVATE');
  });
}
