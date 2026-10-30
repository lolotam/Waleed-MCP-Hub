import { useEffect, useRef, useState } from 'react';
import {
  parseSmartPaste,
  clearSmartPaste,
  type SmartPasteResult,
} from '@waleed/contracts';

export function SmartPaste({
  disabled = false,
  onReview,
}: {
  disabled?: boolean;
  onReview: (value: SmartPasteResult) => void | Promise<void>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [feedback, setFeedback] = useState(''),
    [valid, setValid] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(
    () => () => {
      if (input.current) input.current.value = '';
    },
    [],
  );
  function inspect() {
    setError('');
    let parsed: SmartPasteResult | undefined;
    try {
      parsed = parseSmartPaste(input.current?.value ?? '');
      setFeedback(
        parsed.summary +
          (parsed.kind === 'json' ? '' : ` ${parsed.warnings.join(' ')}`),
      );
      setValid(true);
    } catch (failure) {
      setFeedback(
        failure instanceof Error ? failure.message : 'Input is not supported.',
      );
      setValid(false);
    } finally {
      if (parsed) clearSmartPaste(parsed);
    }
  }
  async function review() {
    let parsed: SmartPasteResult | undefined;
    setBusy(true);
    setError('');
    try {
      parsed = parseSmartPaste(input.current?.value ?? '');
      if (input.current) input.current.value = '';
      setFeedback('');
      setValid(false);
      await onReview(parsed);
    } catch {
      setError(
        'Could not prepare this input. No command was executed. Review the format and try again; private inputs were cleared.',
      );
    } finally {
      if (parsed) clearSmartPaste(parsed);
      if (input.current) input.current.value = '';
      setBusy(false);
    }
  }
  return (
    <section className="review" aria-labelledby="smart-paste-title">
      <h3 id="smart-paste-title">Smart paste</h3>
      <label htmlFor="smart-paste-input">
        URL, npx/uvx command, Docker image/run command, or JSON
      </label>
      <textarea
        ref={input}
        id="smart-paste-input"
        rows={3}
        maxLength={48 * 1024}
        disabled={disabled || busy}
        autoComplete="off"
        spellCheck={false}
        onChange={inspect}
        aria-describedby="smart-paste-feedback"
      />
      <p className="muted">
        Detection is local and data-only. Nothing is installed, contacted, saved
        or executed. Private input is cleared when transferred or closed.
      </p>
      <p id="smart-paste-feedback" role="status">
        {feedback}
      </p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={disabled || busy || !valid}
        onClick={() => void review()}
      >
        {busy ? 'Preparing…' : 'Review detected input'}
      </button>
    </section>
  );
}
