export const onboardingSteps = [
  'Welcome & safety',
  'Connect agents',
  'Add your first MCP',
  'All set',
] as const;
export type OnboardingStep = 0 | 1 | 2 | 3;
export function onboardingStep(
  step: OnboardingStep,
  direction: 'next' | 'back',
): OnboardingStep {
  return Math.max(
    0,
    Math.min(3, step + (direction === 'next' ? 1 : -1)),
  ) as OnboardingStep;
}
// Completion is authoritative even for an empty Hub: Skip Tour must not create
// a loop. Upgraded legacy preferences default to incomplete and show the tour.
export function shouldShowOnboarding(completed: boolean | undefined) {
  return completed === false;
}
