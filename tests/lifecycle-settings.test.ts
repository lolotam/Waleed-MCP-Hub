import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createLifecycleSettings,
  localLifecyclePreferences,
} from '@waleed/hub-core';
import {
  StartupUpdateSchema,
  LifecyclePreferencesUpdateSchema,
} from '@waleed/contracts';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('persists secret-free preferences with CAS, with background checks off by default', async () => {
  const directory = await mkdtemp(
    'E:\\Dev\\Temp\\opencode\\lifecycle-preferences-',
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const first = createLifecycleSettings(localLifecyclePreferences(directory));
  expect(await first.preferences()).toEqual({
    revision: 0,
    backgroundHealthChecks: false,
    keepRunningInTray: true,
    onboardingCompleted: false,
  });
  await first.update({
    expectedRevision: 0,
    backgroundHealthChecks: true,
    keepRunningInTray: false,
    onboardingCompleted: false,
  });
  const second = createLifecycleSettings(localLifecyclePreferences(directory));
  expect(await second.preferences()).toEqual({
    revision: 1,
    backgroundHealthChecks: true,
    keepRunningInTray: false,
    onboardingCompleted: false,
  });
  await expect(
    second.update({
      expectedRevision: 0,
      backgroundHealthChecks: false,
      keepRunningInTray: true,
    }),
  ).rejects.toHaveProperty('code', 'conflict');
  expect(
    JSON.parse(await readFile(join(directory, 'lifecycle.json'), 'utf8')),
  ).not.toHaveProperty('arguments');
});
it('does not overwrite corrupted preference files or silently enable background execution', async () => {
  const directory = await mkdtemp(
    'E:\\Dev\\Temp\\opencode\\lifecycle-corrupt-',
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'lifecycle.json');
  await writeFile(path, 'SYNTHETIC-CORRUPT');
  const settings = createLifecycleSettings(
    localLifecyclePreferences(directory),
  );
  await expect(
    settings.update({
      expectedRevision: 0,
      backgroundHealthChecks: true,
      keepRunningInTray: true,
    }),
  ).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('SYNTHETIC-CORRUPT');
});
it.each([
  { enabled: true, expectedState: 'disabled', path: 'C:\\evil.exe' },
  { enabled: true, expectedState: 'disabled', key: 'HKLM\\Run' },
  { enabled: 'yes', expectedState: 'disabled' },
  { enabled: true, expectedState: 'conflict' },
])('rejects arbitrary startup path/key/command requests %j', (raw) =>
  expect(StartupUpdateSchema.safeParse(raw).success).toBe(false),
);
it('fails closed when no startup adapter is available and rejects arbitrary settings fields', async () => {
  const settings = createLifecycleSettings();
  expect(await settings.startup()).toEqual({
    available: false,
    enabled: false,
    state: 'unavailable',
  });
  await expect(
    settings.setStartup({ enabled: true, expectedState: 'disabled' }),
  ).rejects.toHaveProperty('code', 'unavailable');
  expect(
    LifecyclePreferencesUpdateSchema.safeParse({
      expectedRevision: 0,
      backgroundHealthChecks: true,
      keepRunningInTray: true,
      command: 'evil',
    }).success,
  ).toBe(false);
});
