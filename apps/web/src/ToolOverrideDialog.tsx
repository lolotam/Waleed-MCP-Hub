import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ToolOverrideSchema, type ToolOverride } from '@waleed/contracts';
import { api } from './api.js';
import { Icon } from './Icon.js';

export function ToolOverrideDialog({
  connectorId,
  connectorRevision,
  revision,
  toolName,
  override,
  close,
  refresh,
}: {
  connectorId: string;
  connectorRevision: number;
  revision: number;
  toolName: string;
  override?: ToolOverride | undefined;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    form = useRef<HTMLFormElement>(null),
    initialRevision = useRef(revision);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      form.current?.reset();
      if (prior?.isConnected) prior.focus();
    };
  }, []);
  const stale = initialRevision.current !== revision;
  async function submit(reset: boolean, event?: FormEvent) {
    event?.preventDefault();
    if (stale || busy) return;
    setError('');
    setBusy(true);
    let committed = false;
    try {
      const fields = new FormData(form.current!),
        alias = String(fields.get('alias') ?? '').trim(),
        description = String(fields.get('description') ?? ''),
        annotations = String(fields.get('annotations') ?? '').trim();
      const input = reset
        ? null
        : ToolOverrideSchema.parse({
            connectorId,
            originalToolName: toolName,
            ...(alias ? { alias } : {}),
            ...(description ? { customDescription: description } : {}),
            ...(annotations ? { annotations: JSON.parse(annotations) } : {}),
          });
      const result = await api<{ state: string; recoveryRequired: boolean }>(
        `/api/connectors/${connectorId}/tool-override`,
        {
          expectedRevision: initialRevision.current,
          expectedConnectorRevision: connectorRevision,
          originalToolName: toolName,
          override: input,
        },
      );
      committed = true;
      setSaved(true);
      form.current?.reset();
      await refresh();
      if (result.recoveryRequired)
        setError('Override saved; inspect recovery before further changes.');
      else close();
    } catch {
      setError(
        committed
          ? 'Override saved, but inventory refresh failed. Close and refresh before another change.'
          : 'Override was not confirmed. Use a unique, non-reserved alias, a description up to 2,000 characters and bounded JSON annotations. Refresh if another window changed inventory.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog tool-override-dialog"
      aria-labelledby="tool-override-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="dialog-header">
        <span className="eyebrow">Agent-facing metadata only</span>
        <button
          aria-label="Close tool customization"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="tool-override-title">Customize tool — {toolName}</h2>
      <p className="muted">
        Aliases route to the same original tool. Descriptions and annotations
        are hints, never execution permission. This metadata is saved in the
        Hub; do not paste credentials or arguments here.
      </p>
      <form
        ref={form}
        className="form-fields"
        autoComplete="off"
        onSubmit={(event) => void submit(false, event)}
      >
        <label htmlFor="override-alias">Custom Alias (optional)</label>
        <input
          id="override-alias"
          name="alias"
          defaultValue={override?.alias ?? ''}
          maxLength={64}
          pattern="[a-zA-Z0-9_-]{1,64}"
          spellCheck={false}
          disabled={busy || saved || stale}
        />
        <small className="muted">
          Unique exposed identifier. search_tools and call_tool are reserved.
          Some agents impose shorter prefixed-name limits.
        </small>
        <label htmlFor="override-description">
          Custom Description (optional)
        </label>
        <textarea
          id="override-description"
          name="description"
          defaultValue={override?.customDescription ?? ''}
          rows={5}
          maxLength={2000}
          disabled={busy || saved || stale}
        />
        <small className="muted">
          Leave blank to keep the provider description. No markup or
          instructions are executed by the Hub.
        </small>
        <label htmlFor="override-annotations">
          Annotations (JSON object, optional)
        </label>
        <textarea
          id="override-annotations"
          name="annotations"
          defaultValue={
            override?.annotations
              ? JSON.stringify(override.annotations, null, 2)
              : ''
          }
          placeholder={'{"readOnlyHint": true}'}
          rows={4}
          maxLength={8192}
          spellCheck={false}
          disabled={busy || saved || stale}
        />
        <small className="muted">
          Merged over provider annotations. MCP hint fields must be booleans;
          policies remain authoritative.
        </small>
        {stale && (
          <p role="alert">
            Inventory changed. Close and reopen this form before saving.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || saved || stale || !override}
            onClick={() => void submit(true)}
          >
            Reset to Default
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || saved || stale}
          >
            {busy ? 'Saving…' : 'Save override'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
