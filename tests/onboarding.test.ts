import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createLifecycleSettings,
  localLifecyclePreferences,
  memoryLifecyclePreferences,
} from '@waleed/hub-core';
import {
  LifecyclePreferencesSchema,
  OnboardingStatusSchema,
  OnboardingUpdateSchema,
} from '@waleed/contracts';
import {
  onboardingStep,
  shouldShowOnboarding,
  onboardingSteps,
} from '../apps/web/src/onboarding.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('keeps the four tour steps bounded and makes completion authoritative for an empty workspace', () => {
  expect(onboardingSteps).toHaveLength(4);
  expect(onboardingStep(0, 'back')).toBe(0);
  expect(onboardingStep(3, 'next')).toBe(3);
  expect(onboardingStep(onboardingStep(0, 'next'), 'next')).toBe(2);
  expect(onboardingStep(2, 'back')).toBe(1);
  expect(shouldShowOnboarding(undefined)).toBe(false);
  expect(shouldShowOnboarding(false)).toBe(true);
  expect(shouldShowOnboarding(true)).toBe(false);
});
it('migrates legacy preferences without enabling background actions or writing on read, and persists finish/skip/reset', async () => {
  const directory = await mkdtemp('E:\\Dev\\Temp\\opencode\\onboarding-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'lifecycle.json'),
    legacy = {
      revision: 3,
      backgroundHealthChecks: false,
      keepRunningInTray: true,
    };
  await writeFile(path, JSON.stringify(legacy));
  const first = createLifecycleSettings(localLifecyclePreferences(directory));
  expect(await first.onboarding()).toEqual({
    revision: 3,
    onboardingCompleted: false,
  });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(legacy);
  await first.setOnboarding({ expectedRevision: 3, onboardingCompleted: true });
  const second = createLifecycleSettings(localLifecyclePreferences(directory));
  expect(OnboardingStatusSchema.parse(await second.onboarding())).toEqual({
    revision: 4,
    onboardingCompleted: true,
  });
  expect(await second.preferences()).toMatchObject({
    backgroundHealthChecks: false,
    keepRunningInTray: true,
  });
  await second.setOnboarding({
    expectedRevision: 4,
    onboardingCompleted: false,
  });
  expect((await first.onboarding()).onboardingCompleted).toBe(false);
});
it('preserves onboarding when an older lifecycle UI saves settings, and preserves lifecycle options when finishing a tour', async () => {
  const settings = createLifecycleSettings();
  await settings.update({
    expectedRevision: 0,
    backgroundHealthChecks: true,
    keepRunningInTray: false,
  });
  await settings.setOnboarding({
    expectedRevision: 1,
    onboardingCompleted: true,
  });
  expect(await settings.preferences()).toEqual({
    revision: 2,
    backgroundHealthChecks: true,
    keepRunningInTray: false,
    onboardingCompleted: true,
  });
  await settings.update({
    expectedRevision: 2,
    backgroundHealthChecks: false,
    keepRunningInTray: true,
  });
  expect((await settings.onboarding()).onboardingCompleted).toBe(true);
});
it('rejects stale, arbitrary and cross-purpose onboarding changes', async () => {
  const settings = createLifecycleSettings();
  await settings.setOnboarding({
    expectedRevision: 0,
    onboardingCompleted: true,
  });
  await expect(
    settings.setOnboarding({ expectedRevision: 0, onboardingCompleted: false }),
  ).rejects.toHaveProperty('code', 'conflict');
  for (const input of [
    { expectedRevision: 1, onboardingCompleted: 'yes' },
    {
      expectedRevision: 1,
      onboardingCompleted: true,
      backgroundHealthChecks: true,
    },
    { onboardingCompleted: false },
    { expectedRevision: -1, onboardingCompleted: false },
  ])
    expect(OnboardingUpdateSchema.safeParse(input).success).toBe(false);
  expect(
    LifecyclePreferencesSchema.parse({
      revision: 0,
      backgroundHealthChecks: false,
      keepRunningInTray: true,
    }).onboardingCompleted,
  ).toBe(false);
});
it('keeps failures honest, shares the settings mutation lock and respects blocking recovery', async () => {
  const store = memoryLifecyclePreferences(),
    settings = createLifecycleSettings(store);
  store.write = async () => {
    throw new Error('Synthetic failed atomic settings write.');
  };
  await expect(
    settings.setOnboarding({ expectedRevision: 0, onboardingCompleted: true }),
  ).rejects.toThrow();
  expect((await settings.onboarding()).onboardingCompleted).toBe(false);
  const blocked = createLifecycleSettings(undefined, undefined, async () => {
    throw new Error('Blocked recovery.');
  });
  await expect(
    blocked.setOnboarding({ expectedRevision: 0, onboardingCompleted: true }),
  ).rejects.toThrow();
  expect((await blocked.onboarding()).onboardingCompleted).toBe(false);
  let release!: () => void;
  const lock = createLifecycleSettings(
    undefined,
    undefined,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const save = lock.setOnboarding({
    expectedRevision: 0,
    onboardingCompleted: true,
  });
  await expect(
    lock.update({
      expectedRevision: 0,
      backgroundHealthChecks: true,
      keepRunningInTray: false,
    }),
  ).rejects.toHaveProperty('code', 'busy');
  release();
  await save;
});
