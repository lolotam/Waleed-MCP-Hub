import { useEffect, useState, useRef } from 'react';
import {
  LifecyclePreferencesSchema,
  StartupStatusSchema,
  type LifecyclePreferences,
  type StartupStatus,
} from '@waleed/contracts';
import { api } from './api.js';
export function LifecycleSettings({
  blocked,
  desktop,
}: {
  blocked: boolean;
  desktop: boolean;
}) {
  const [startup, setStartup] = useState<StartupStatus | null>(null),
    [preferences, setPreferences] = useState<LifecyclePreferences | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [pendingStartup, setPendingStartup] = useState<boolean | null>(null),
    epoch = useRef(0);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const version = epoch.current;
      try {
        const [s, p] = await Promise.all([
          api('/api/lifecycle/startup'),
          api('/api/lifecycle/preferences'),
        ]);
        if (!stopped && version === epoch.current) {
          setStartup(StartupStatusSchema.parse(s));
          setPreferences(LifecyclePreferencesSchema.parse(p));
        }
      } catch {
        if (!stopped)
          setError(
            'Lifecycle status unavailable. Refresh before changing settings.',
          );
      } finally {
        if (!stopped) timer = setTimeout(() => void load(), 10000);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  async function toggleStartup(enabled: boolean) {
    if (!startup || !['enabled', 'disabled'].includes(startup.state)) return;
    setBusy(true);
    epoch.current++;
    setPendingStartup(enabled);
    setNotice('');
    setError('');
    try {
      const result = StartupStatusSchema.parse(
        await api('/api/lifecycle/startup', {
          enabled,
          expectedState: startup.state,
        }),
      );
      setStartup(result);
      setNotice(
        enabled
          ? 'Start with Windows enabled for this Hub launcher.'
          : 'Start with Windows disabled.',
      );
    } catch {
      setError(
        'Startup change was not confirmed. A missing launcher or conflicting entry is never overwritten.',
      );
      try {
        setStartup(
          StartupStatusSchema.parse(await api('/api/lifecycle/startup')),
        );
      } catch {
        setStartup(null);
      }
    } finally {
      setPendingStartup(null);
      setBusy(false);
    }
  }
  async function change(extra: Partial<LifecyclePreferences>) {
    if (!preferences) return;
    setBusy(true);
    epoch.current++;
    setPreferences({ ...preferences, ...extra });
    setNotice('');
    setError('');
    try {
      setPreferences(
        LifecyclePreferencesSchema.parse(
          await api('/api/lifecycle/preferences', {
            expectedRevision: preferences.revision,
            backgroundHealthChecks: preferences.backgroundHealthChecks,
            keepRunningInTray: preferences.keepRunningInTray,
            ...extra,
          }),
        ),
      );
      setNotice('Lifecycle preferences saved.');
    } catch {
      setError(
        'Preferences changed or storage is unavailable. Refresh before retrying.',
      );
      setPreferences(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="list-panel integration-guidance lifecycle-settings">
      <h2>Health & Windows lifecycle</h2>
      <label className="import-check">
        <input
          type="checkbox"
          checked={pendingStartup ?? startup?.enabled ?? false}
          disabled={
            busy ||
            blocked ||
            !startup?.available ||
            !['enabled', 'disabled'].includes(startup.state)
          }
          onChange={(event) => void toggleStartup(event.target.checked)}
        />
        Start with Windows
      </label>
      <p className="muted">
        Current-user HKCU Run only. Launches this Hub in the tray without
        opening a window.{' '}
        {startup?.state === 'conflict'
          ? 'A conflicting startup entry exists; it was left unchanged.'
          : !startup?.available
            ? 'Unavailable until the reviewed Windows launcher is built.'
            : 'No administrator rights or service installation.'}
      </p>
      <label className="import-check">
        <input
          type="checkbox"
          checked={preferences?.backgroundHealthChecks ?? false}
          disabled={busy || blocked || !preferences}
          onChange={(event) =>
            void change({ backgroundHealthChecks: event.target.checked })
          }
        />
        Automatic background health checks
      </label>
      <p className="muted">
        Every 5 minutes, re-test enabled, approved connectors. May start their
        contained processes. No tool calls, resource reads, prompt gets or
        package installation. Off by default.
      </p>
      <label className="import-check">
        <input
          type="checkbox"
          checked={preferences?.keepRunningInTray ?? true}
          disabled={busy || blocked || !preferences || !desktop}
          onChange={(event) =>
            void change({ keepRunningInTray: event.target.checked })
          }
        />
        Keep running in tray when the app window closes
      </label>
      <p className="muted">
        The compiled launcher provides Open, Check Health and Exit. When off,
        closing an observed Hub Edge window stops the manager. If Edge window
        ownership cannot be verified, use tray Exit or Stop desktop manager.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
