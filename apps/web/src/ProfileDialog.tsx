import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Job, OperationPreview } from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';

export function ProfileDialog({
  revision,
  close,
  saved,
}: {
  revision: number;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [done, setDone] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    nameInput.current?.focus();
    return () => {
      mounted.current = false;
      if (previous?.matches(':disabled'))
        document.getElementById('main')?.focus();
      else previous?.focus();
    };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if ((name || description) && !done) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [name, description, done]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        setPreview(
          await api<OperationPreview>('/api/operations/preview', {
            kind: 'create_profile',
            expectedRevision: revision,
            name,
            description,
          }),
        );
      } else {
        let current = await api<Job>('/api/operations/apply', {
          previewId: preview.id,
        });
        setJob(current);
        const deadline = Date.now() + 15_000;
        while (
          ['queued', 'running'].includes(current.state) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
          current = await api<Job>(`/api/jobs/${current.id}`);
          if (!mounted.current) return;
          setJob(current);
        }
        if (current.state !== 'succeeded')
          throw new Error(
            current.reason ??
              'The save is still pending. Close this dialog and refresh to inspect the registry before retrying.',
          );
        await saved();
        // Keep completion/close unavailable while the refreshed opener is still
        // disabled; otherwise focus restoration races the inventory refresh.
        if (mounted.current) setDone(true);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'The operation failed.',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="profile-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="dialog-header">
          <div className="eyebrow">LOCAL REGISTRY ONLY</div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="profile-title">
          {done
            ? 'Profile created'
            : preview
              ? 'Review your changes'
              : 'Create a profile'}
        </h2>
        {done ? (
          <>
            <div className="success-message">
              <Icon name="check" />
              <p>
                <strong>{name}</strong> is saved locally. No Docker or agent
                configuration changed.
              </p>
            </div>
            {job?.reason && (
              <p className="notice" role="alert">
                {job.reason}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="muted">
              Start with an empty local profile. Then edit its membership and
              explicitly apply the managed snapshot; creating it starts nothing.
            </p>
            {!preview ? (
              <div className="form-fields">
                <label htmlFor="profile-name">Profile name</label>
                <input
                  ref={nameInput}
                  id="profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                  placeholder="e.g. Development"
                />
                <label htmlFor="profile-description">
                  Description <span className="muted">(optional)</span>
                </label>
                <textarea
                  id="profile-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={1000}
                  rows={3}
                />
              </div>
            ) : (
              <section className="review">
                <h3>{name}</h3>
                {description && <p>{description}</p>}
                <ul>
                  {preview.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                <p className="notice">{preview.warnings[0]}</p>
                <small>
                  Based on registry revision {preview.expectedRevision}. Preview
                  expires in 5 minutes.
                </small>
              </section>
            )}
            {job && <p role="status">Save: {job.state}</p>}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </>
        )}
        <footer className="dialog-footer">
          {done ? (
            <button className="primary" type="button" onClick={close}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => (preview ? setPreview(null) : close())}
              >
                {preview ? 'Back' : 'Cancel'}
              </button>
              <button className="primary" disabled={busy} type="submit">
                {busy
                  ? 'Working…'
                  : preview
                    ? 'Apply local change'
                    : 'Preview changes'}
                {!busy && <Icon name="arrow" size={16} />}
              </button>
            </>
          )}
        </footer>
      </form>
    </dialog>
  );
}
