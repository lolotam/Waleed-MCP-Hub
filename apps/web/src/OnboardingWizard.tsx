import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import {
  onboardingSteps,
  onboardingStep,
  type OnboardingStep,
} from './onboarding.js';
export function OnboardingWizard({
  step,
  setStep,
  busy,
  blocked,
  notice,
  error,
  complete,
  connectAgents,
  add,
  go,
  help,
}: {
  step: OnboardingStep;
  setStep: (step: OnboardingStep) => void;
  busy: boolean;
  blocked: boolean;
  notice: string;
  error: string;
  complete: () => void;
  connectAgents: ReactNode;
  add: (kind: 'registry' | 'paste' | 'package') => void;
  go: (target: 'playground' | 'tools') => void;
  help: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null),
    previous = useRef(step);
  useEffect(() => {
    if (previous.current !== step) {
      title.current?.focus();
      previous.current = step;
    }
  }, [step]);
  return (
    <section
      className="list-panel onboarding-wizard"
      aria-labelledby="onboarding-title"
    >
      <div className="onboarding-heading">
        <div>
          <span className="eyebrow">GET STARTED · STEP {step + 1} OF 4</span>
          <h2 ref={title} tabIndex={-1} id="onboarding-title">
            {onboardingSteps[step]}
          </h2>
        </div>
        <span className="read-only-tag">Review before change</span>
      </div>
      <ol className="onboarding-progress" aria-label="Onboarding progress">
        {onboardingSteps.map((title, index) => (
          <li key={title} aria-current={index === step ? 'step' : undefined}>
            <span>{index + 1}</span>
            {title}
          </li>
        ))}
      </ol>
      <div className="onboarding-body" key={step}>
        {step === 0 && (
          <>
            <p>
              Welcome to Waleed MCP Hub. Connect tools to your agents without
              handing over control of your computer.
            </p>
            <div className="onboarding-safety">
              <div>
                <Icon name="lock" />
                <h3>Protected credentials</h3>
                <p>
                  The native credential vault protects values for your user;
                  Settings shows its backend and health. Docker uses its
                  reference-only vault. Never paste keys into names or
                  arguments.
                </p>
              </div>
              <div>
                <Icon name="shield" />
                <h3>Contained execution</h3>
                <p>
                  Windows uses JobObject containment. POSIX uses process-group
                  cleanup, not a security sandbox. Both use explicit
                  environments; there is no uncontained fallback.
                </p>
              </div>
              <div>
                <Icon name="check" />
                <h3>You review every change</h3>
                <p>
                  Save, approve execution, install packages and call tools are
                  distinct actions. This tour does not scan, connect or run
                  anything automatically.
                </p>
              </div>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <p>
              Scan local agent configurations, review the exact file and consent
              to changes before 1-Click Integrate. Integrated means configured,
              not authenticated or live-connected.
            </p>
            {connectAgents}
          </>
        )}
        {step === 2 && (
          <>
            <p>
              Choose how to add a server. Every option opens an existing review
              flow; no connector is created, installed or approved just by
              choosing.
            </p>
            <div className="onboarding-choices">
              <button
                disabled={blocked || busy}
                onClick={() => add('registry')}
              >
                <strong>Browse Official Registry</strong>
                <span>
                  Search publisher metadata. Registry presence is not trust.
                </span>
              </button>
              <button disabled={blocked || busy} onClick={() => add('paste')}>
                <strong>Smart Paste</strong>
                <span>
                  Review a URL, pinned package command, Docker command or JSON.
                </span>
              </button>
              <button disabled={blocked || busy} onClick={() => add('package')}>
                <strong>Managed Packages</strong>
                <span>
                  Set an exact npm/uvx version and executable. Install only
                  after consent.
                </span>
              </button>
            </div>
            <p className="muted">
              You can finish the tour without configuring a connector. Nothing
              runs until you review and explicitly approve it.
            </p>
          </>
        )}
        {step === 3 && (
          <>
            <p>
              Your tour is ready to finish. This is not a claim that any
              connector is authenticated, approved or connected.
            </p>
            <div className="onboarding-choices">
              <button onClick={() => go('playground')}>Open Playground</button>
              <button onClick={() => go('tools')}>Tools & Permissions</button>
              <button onClick={help}>Help & Guides</button>
            </div>
            <p className="muted">
              Finish saves only your onboarding preference. Re-run it anytime in
              Settings.
            </p>
          </>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="onboarding-actions">
        <button disabled={busy || blocked} onClick={complete}>
          Skip Tour
        </button>
        <div>
          <button
            disabled={step === 0 || busy}
            onClick={() => setStep(onboardingStep(step, 'back'))}
          >
            Back
          </button>
          {step < 3 ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => setStep(onboardingStep(step, 'next'))}
            >
              Next
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || blocked}
              onClick={complete}
            >
              {busy ? 'Saving…' : 'Finish'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
