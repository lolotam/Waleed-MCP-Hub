import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Job, OperationPreview } from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';

export interface OperationDialogInput {
  title: string;
  operation: Record<string, unknown>;
  editor?: 'definition' | 'profile';
  context?: unknown;
  initialPreview?: OperationPreview;
}
export function OperationDialog({
  input,
  revision,
  close,
  refresh,
}: {
  input: OperationDialogInput;
  revision: number;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const [preview, setPreview] = useState<OperationPreview | null>(
    input.initialPreview ?? null,
  );
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [reviewContext, setReviewContext] = useState(input.context);
  useEffect(() => {
    mounted.current = true;
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      if (editor.current) editor.current.value = '';
      if (prior?.isConnected && !prior.matches(':disabled')) prior.focus();
      else document.getElementById('main')?.focus();
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        let operation: Record<string, unknown> = {
          ...input.operation,
          expectedRevision: revision,
        };
        if (input.editor) {
          let edited: unknown;
          try {
            edited = JSON.parse(editor.current?.value ?? '');
          } catch {
            throw new Error('Use a JSON object. No operation was submitted.');
          }
          if (input.editor === 'definition')
            operation = { ...operation, definition: edited };
          else if (
            edited &&
            typeof edited === 'object' &&
            !Array.isArray(edited)
          )
            operation = { ...edited, ...operation };
          else throw new Error('Use a JSON object.');
        }
        const next = await api<OperationPreview>(
          '/api/operations/preview',
          operation,
        );
        if (editor.current) editor.current.value = '';
        if (mounted.current) {
          // Retain only a successfully validated public definition, never a
          // rejected editor payload or private import input.
          if (input.editor) setReviewContext(operation.definition ?? operation);
          setPreview(next);
        }
      } else {
        let current = await api<Job>('/api/operations/apply', {
          previewId: preview.id,
        });
        if (mounted.current) setJob(current);
        const deadline = Date.now() + 100_000;
        while (
          ['queued', 'running'].includes(current.state) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
          current = await api<Job>(`/api/jobs/${current.id}`);
          if (mounted.current) setJob(current);
        }
        await refresh();
        if (current.state !== 'succeeded')
          throw new Error(
            current.reason ??
              'The operation is still pending. Inspect Activity/recovery before retrying.',
          );
      }
    } catch (failure) {
      if (editor.current) editor.current.value = '';
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Operation failed. Inspect recovery before retrying.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const done = job?.state === 'succeeded';
  const consumed = !!job;
  return (
    <dialog
      ref={dialog}
      className="import-dialog"
      aria-labelledby="operation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        autoComplete="off"
      >
        <div className="dialog-header">
          <div className="eyebrow">REVISION-BOUND CHANGE</div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close operation dialog"
            disabled={busy}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="operation-title">
          {done ? 'Operation completed' : input.title}
        </h2>
        <p className="muted">
          Local registry saves, execution approval, managed profile apply and
          capability tests are separate. No agent configuration or secret store
          is changed here.
        </p>
        {reviewContext !== undefined && (
          <details>
            <summary>Exact definition / context</summary>
            <pre>{JSON.stringify(reviewContext, null, 2)}</pre>
          </details>
        )}
        {!preview && input.editor && (
          <div className="form-fields">
            <label htmlFor="operation-json">
              {input.editor === 'definition'
                ? 'Editable connector definition (JSON)'
                : 'Profile settings and connectorIds (JSON)'}
            </label>
            <textarea
              id="operation-json"
              ref={editor}
              rows={12}
              defaultValue={JSON.stringify(
                input.editor === 'definition'
                  ? input.operation.definition
                  : input.context,
                null,
                2,
              )}
              maxLength={48 * 1024}
              spellCheck={false}
              required
            />
          </div>
        )}
        {input.operation.kind === 'approve_connector' && !done && (
          <label className="import-check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              required
            />
            I trust this exact executable/image/endpoint and its
            file/network/download permissions.
          </label>
        )}
        {preview && (
          <section className="review">
            <h3>{preview.summary}</h3>
            <p>
              Registry revision {preview.expectedRevision} · target{' '}
              {preview.targetId ?? 'local registry'}.
            </p>
            <ul>
              {preview.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
            {preview.warnings.map((warning) => (
              <p className="notice" key={warning}>
                {warning}
              </p>
            ))}
            <p>
              Affected profiles:{' '}
              {preview.affectedProfiles?.join(', ') || 'none'} · agents
              requiring reconnect:{' '}
              {preview.affectedAgents?.join(', ') || 'none recorded'}.
            </p>
            {!!preview.files?.length && (
              <details>
                <summary>Owned files to change</summary>
                <ul>
                  {preview.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
        {job && (
          <p role="status">
            Operation: {job.state}
            {job.reason ? ` · ${job.reason}` : ''}
          </p>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-footer import-footer">
          <button type="button" disabled={busy} onClick={close}>
            {consumed ? 'Close' : 'Cancel'}
          </button>
          {busy &&
            job &&
            ['materialize_profile', 'dematerialize_profile'].includes(
              job.operation,
            ) && (
              <button
                type="button"
                onClick={() => {
                  void api(`/api/jobs/${job.id}/cancel`, {}).catch(() =>
                    setError(
                      'Cancellation could not be confirmed. Inspect the job before retrying.',
                    ),
                  );
                }}
              >
                Cancel owned apply
              </button>
            )}
          {!consumed && (
            <button
              className="primary"
              type="submit"
              disabled={
                busy ||
                (input.operation.kind === 'approve_connector' && !consent)
              }
            >
              {busy
                ? 'Working…'
                : preview
                  ? 'Apply reviewed change'
                  : 'Preview operation'}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
