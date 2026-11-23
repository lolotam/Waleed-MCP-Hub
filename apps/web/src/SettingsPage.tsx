import type { Bootstrap, DiscoverySnapshot } from '@waleed/contracts';
import { themeChoices, type ThemeChoice } from './theme.js';

// The Light, Dark and System choice. It is a local setting of this browser,
// so it works even when the hub did not answer.
export function Appearance({
  theme,
  choose,
}: {
  theme: ThemeChoice;
  choose: (choice: ThemeChoice) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="Appearance">
      {themeChoices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          aria-pressed={theme === choice.id}
          onClick={() => choose(choice.id)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

// Shown on Settings › Runtime & safeguards in place of the page body while the
// hub could not be read, so the local settings stay reachable.
export function AppearancePanel(props: {
  theme: ThemeChoice;
  choose: (choice: ThemeChoice) => void;
}) {
  return (
    <section className="list-panel settings">
      <div className="list-toolbar">
        <h2>Appearance</h2>
      </div>
      <dl>
        <div>
          <dt>Appearance</dt>
          <dd>
            <Appearance {...props} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function RuntimeSettings({
  bootstrap,
  discovery,
  recoveryBlocked,
  theme,
  chooseTheme,
  stopDesktop,
}: {
  bootstrap: Bootstrap | null;
  discovery: DiscoverySnapshot | null;
  recoveryBlocked: boolean;
  theme: ThemeChoice;
  chooseTheme: (choice: ThemeChoice) => void;
  stopDesktop: () => void;
}) {
  return (
    <>
      {bootstrap?.capabilities.desktop && (
        <section className="list-panel integration-guidance">
          <h2>Windows desktop session</h2>
          <p>
            Closing the app window leaves the same-user manager running. Use
            this action to release its locks and shut down gracefully;
            independent agent bridges remain agent-owned.
          </p>
          <button onClick={stopDesktop}>Stop desktop manager</button>
        </section>
      )}
      <section className="list-panel settings">
        <div className="list-toolbar">
          <h2>Runtime & safeguards</h2>
        </div>
        <dl>
          <div>
            <dt>Local server</dt>
            <dd>{window.location.origin}</dd>
          </div>
          <div>
            <dt>Node.js</dt>
            <dd>{bootstrap?.runtime.node}</dd>
          </div>
          <div>
            <dt>State storage</dt>
            <dd>Versioned JSON · atomic replacement · 5 backups</dd>
          </div>
          <div>
            <dt>Recovery journal</dt>
            <dd>
              {recoveryBlocked
                ? 'Review required · changes blocked'
                : 'No unresolved operations'}{' '}
              · external uncertainty blocks for review
            </dd>
          </div>
          <div>
            <dt>Refusal audit</dt>
            <dd>Persisted locally · latest 200 · no request payloads</dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd>One-time launch · HttpOnly session · CSRF protection</dd>
          </div>
          <div>
            <dt>Docker discovery</dt>
            <dd>
              {discovery?.checkedAt
                ? `${discovery.docker.state} · CLI ${discovery.docker.cliVersion ?? 'unknown'} · gateway ${discovery.docker.gatewayVersion ?? 'unknown'} · engine ${discovery.docker.engineVersion ?? 'unknown'} · ${discovery.docker.reason.replaceAll('_', ' ')}`
                : 'Not scanned · only explicit read-only discovery runs Docker queries'}
            </dd>
          </div>
          <div>
            <dt>Secret storage & OAuth</dt>
            <dd>
              {bootstrap?.capabilities.secrets
                ? 'Write-only protected credentials · supported OAuth recipes only · discovery required for verification'
                : 'Protected credential backend unavailable'}
            </dd>
          </div>
          <div>
            <dt>Windows sign-in startup</dt>
            <dd>
              Managed by the tray icon · right-click the Waleed MCP Hub icon and
              use Start with Windows
            </dd>
          </div>
          <div>
            <dt>Appearance</dt>
            <dd>
              <Appearance theme={theme} choose={chooseTheme} />
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}

// Settings › Recovery. While changes are blocked the recovery alert above the
// page is this tab's content; when nothing is blocked this says so.
export function RecoveryStatus({ blocked }: { blocked: boolean }) {
  if (blocked) return null;
  return (
    <section className="list-panel settings">
      <div className="list-toolbar">
        <h2>Recovery journal</h2>
      </div>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>No unresolved operations</dd>
        </div>
        <div>
          <dt>If an operation is left unfinished</dt>
          <dd>
            Further changes are blocked for review. Nothing is replayed or
            rolled back automatically.
          </dd>
        </div>
      </dl>
    </section>
  );
}
