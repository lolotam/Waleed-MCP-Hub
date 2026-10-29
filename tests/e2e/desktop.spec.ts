import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { createServer } from 'node:net';
test('desktop single-instance reopen issues fresh fragment launches and protected shutdown releases writer locks', async ({
  page,
}) => {
  test.skip(
    process.platform !== 'win32',
    'Windows named-pipe desktop runtime.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'hub-desktop-browser-'));
  const children: ChildProcess[] = [];
  const start = () => {
    const child = fork('tests/fixtures/desktop-host.mjs', [], {
      execArgv: [],
      env: { ...process.env, HUB_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    return child;
  };
  const message = (child: ChildProcess) =>
    new Promise<{ launchUrl?: string; reused?: boolean; pid?: number }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Desktop fixture startup timed out.')),
          15000,
        );
        child.once('message', (value) => {
          clearTimeout(timer);
          resolve(
            value as { launchUrl?: string; reused?: boolean; pid?: number },
          );
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Desktop host exited before readiness.'));
        });
      },
    );
  try {
    const first = start(),
      launch = await message(first);
    expect(new URL(launch.launchUrl!).search).toBe('');
    await page.goto(launch.launchUrl!);
    await expect(
      page.getByRole('heading', { name: 'Connectors', exact: true }),
    ).toBeVisible();
    const reopen = message(first);
    const second = start();
    expect((await message(second)).reused).toBe(true);
    const next = await reopen;
    expect(next.pid).toBe(launch.pid);
    expect(next.launchUrl).not.toBe(launch.launchUrl);
    await page.goto(next.launchUrl!);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('button', { name: 'Stop desktop manager', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'Desktop manager stopped',
    );
    await expect
      .poll(async () => {
        try {
          await access(`${directory}\\writer.lock`);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    for (const child of children)
      if (child.exitCode === null) {
        const exit = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        if (child.connected) child.send('shutdown', () => undefined);
        const timer = setTimeout(() => child.kill(), 5000);
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
test('desktop port conflict releases owned locks and exits without stopping its owner', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop runtime.');
  const directory = await mkdtemp(join(tmpdir(), 'hub-desktop-conflict-'));
  const owner = createServer();
  let child: ChildProcess | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      owner.once('error', reject);
      owner.listen(4196, '127.0.0.1', resolve);
    });
    child = fork('tests/fixtures/desktop-host.mjs', [], {
      execArgv: [],
      env: { ...process.env, HUB_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Conflicted desktop did not exit.')),
        15000,
      );
      child!.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(code).toBe(1);
    expect(owner.listening).toBe(true);
    await expect(access(`${directory}\\writer.lock`)).rejects.toBeDefined();
    await expect(access(`${directory}\\safety.lock`)).rejects.toBeDefined();
  } finally {
    if (child && child.exitCode === null) {
      const exit = new Promise<void>((resolve) =>
        child!.once('exit', () => resolve()),
      );
      child.kill();
      await exit;
    }
    await new Promise<void>((resolve) => owner.close(() => resolve()));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
});
