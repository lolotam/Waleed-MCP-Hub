import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { windowsStartupRegistration } from '@waleed/hub-core';

it.skipIf(process.platform !== 'win32')(
  'compiled launcher toggles only a disposable fixed HKCU value and refuses conflicts/stale expectations',
  async () => {
    const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\startup-hkcu-'),
      suffix = randomUUID(),
      key = `HKCU\\Software\\WaleedMcpHub\\StartupTest-${suffix}`,
      reg = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'reg.exe',
      ),
      run = promisify(execFile);
    try {
      await mkdir(join(directory, 'scripts'));
      const source = (
        await readFile('scripts/WaleedMcpHub.cs', 'utf8')
      ).replace(
        'Software\\WaleedMcpHub\\StartupTest',
        `Software\\WaleedMcpHub\\StartupTest-${suffix}`,
      );
      await writeFile(join(directory, 'scripts', 'WaleedMcpHub.cs'), source);
      await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {buildLauncher} from './scripts/build-launcher.mjs'; await buildLauncher(process.argv[1],{testRegistry:true});",
          directory,
        ],
        { cwd: resolve('.'), timeout: 30000 },
      );
      const startup = windowsStartupRegistration(directory);
      expect(await startup.query()).toEqual({
        available: true,
        state: 'disabled',
        enabled: false,
      });
      expect(await startup.set(true, 'disabled')).toMatchObject({
        enabled: true,
      });
      const actual = await run(reg, ['query', key, '/v', 'WaleedMcpHub']);
      expect(actual.stdout).toContain(
        `"${join(directory, 'WaleedMcpHub.exe')}" --background`,
      );
      await expect(startup.set(false, 'disabled')).rejects.toHaveProperty(
        'code',
        'conflict',
      );
      expect((await startup.query()).enabled).toBe(true);
      expect((await startup.set(false, 'enabled')).enabled).toBe(false);
      await run(reg, [
        'add',
        key,
        '/v',
        'WaleedMcpHub',
        '/t',
        'REG_SZ',
        '/d',
        'SYNTHETIC-OTHER-INSTALLATION',
        '/f',
      ]);
      expect(await startup.query()).toMatchObject({
        state: 'conflict',
        enabled: false,
      });
      await expect(startup.set(true, 'disabled')).rejects.toHaveProperty(
        'code',
        'conflict',
      );
      expect(
        (await run(reg, ['query', key, '/v', 'WaleedMcpHub'])).stdout,
      ).toContain('SYNTHETIC-OTHER-INSTALLATION');
      const tray = await run(
        join(directory, 'WaleedMcpHub.exe'),
        ['--tray-self-test'],
        { timeout: 10000 },
      );
      expect(tray.stdout.trim()).toBe(
        'wmh-tray-v1:Open Waleed MCP Hub|Check Health|Exit',
      );
      await writeFile(
        join(directory, 'scripts', 'WaleedMcpHub.cs'),
        source + '\n// changed',
      );
      expect((await startup.query()).available).toBe(false);
    } finally {
      await run(reg, ['delete', key, '/f']).catch(() => undefined);
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
  60000,
);
it.skipIf(process.platform !== 'win32')(
  'queries real HKCU Run read-only through a verified launcher, without changing the user startup entry',
  async () => {
    const directory = await mkdtemp(
      'E:\\Dev\\Temp\\opencode\\startup-readonly-',
    );
    try {
      await mkdir(join(directory, 'scripts'));
      await copyFile(
        'scripts/WaleedMcpHub.cs',
        join(directory, 'scripts', 'WaleedMcpHub.cs'),
      );
      await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {buildLauncher} from './scripts/build-launcher.mjs'; await buildLauncher(process.argv[1]);",
          directory,
        ],
        { cwd: resolve('.'), timeout: 30000 },
      );
      const result = await windowsStartupRegistration(directory).query();
      expect(result.available).toBe(true);
      expect(['disabled', 'conflict']).toContain(result.state);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
  45000,
);
