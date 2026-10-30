import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
test('background desktop waits for explicit Open, accepts health action and drains on Exit', async ({
  page,
}) => {
  test.skip(process.platform !== 'win32', 'Windows named pipe lifecycle.');
  const directory = await mkdtemp(
    'E:\\Dev\\Temp\\opencode\\desktop-background-',
  );
  let child: ChildProcess | undefined;
  try {
    child = fork('tests/fixtures/desktop-host.mjs', [], {
      execArgv: [],
      env: {
        ...process.env,
        HUB_DATA_DIR: directory,
        HUB_TEST_BACKGROUND: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: Array<{
      background?: boolean;
      launchUrl?: string;
      preferences?: { keepRunningInTray: boolean };
    }> = [];
    child.on('message', (message) =>
      messages.push(message as (typeof messages)[number]),
    );
    await expect
      .poll(() => messages.some((message) => message.background), {
        timeout: 15000,
      })
      .toBe(true);
    await expect
      .poll(() => messages.some((message) => message.preferences), {
        timeout: 15000,
      })
      .toBe(true);
    expect(messages.some((message) => message.launchUrl)).toBe(false);
    child.send('health');
    child.send('open');
    await expect
      .poll(() => messages.find((message) => message.launchUrl)?.launchUrl, {
        timeout: 15000,
      })
      .toBeTruthy();
    await page.goto(messages.find((message) => message.launchUrl)!.launchUrl!);
    await expect(
      page.getByRole('heading', { name: 'Connectors', exact: true }),
    ).toBeVisible();
    const result = await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      return (
        await fetch('/api/lifecycle/preferences', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': session.csrfToken,
          },
          body: JSON.stringify({
            expectedRevision: 0,
            backgroundHealthChecks: false,
            keepRunningInTray: false,
          }),
        })
      ).status;
    });
    expect(result).toBe(200);
    await expect
      .poll(() =>
        messages.some(
          (message) => message.preferences?.keepRunningInTray === false,
        ),
      )
      .toBe(true);
    const exited = new Promise<void>((resolve) =>
      child!.once('exit', () => resolve()),
    );
    child.send('shutdown');
    await exited;
    await expect(access(`${directory}\\writer.lock`)).rejects.toBeDefined();
    await expect(access(`${directory}\\safety.lock`)).rejects.toBeDefined();
  } finally {
    if (child && child.exitCode === null) {
      const exit = new Promise<void>((resolve) =>
        child!.once('exit', () => resolve()),
      );
      if (child.connected) child.send('shutdown');
      const timer = setTimeout(() => child!.kill(), 5000);
      try {
        await exit;
      } finally {
        clearTimeout(timer);
      }
    }
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
});
