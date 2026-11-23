import type { HubState, SecurityEvent } from '@waleed/contracts';
import { Icon } from './Icon.js';

// Activity: each of the two logs is a tab of its own.
export function ActivityPage({
  tab,
  activity,
  securityEvents,
}: {
  tab: string | undefined;
  activity: HubState['activity'];
  securityEvents: SecurityEvent[];
}) {
  if (tab === 'refusals')
    return (
      <section className="list-panel" aria-labelledby="security-activity-title">
        <div className="list-toolbar">
          <h2 id="security-activity-title">Security refusals</h2>
          <span className="muted">Latest 200 · metadata only</span>
        </div>
        {securityEvents.length === 0 ? (
          <div className="empty-state">
            <Icon name="shield" size={28} />
            <h2>No refused requests recorded</h2>
            <p>
              Denied origins, missing sessions, invalid inputs, and conflicts
              appear here without headers, credentials, or request bodies.
            </p>
          </div>
        ) : (
          <ul className="activity-list">
            {[...securityEvents].reverse().map((event) => (
              <li key={event.id}>
                <Icon name="shield" size={18} />
                <div className="row-main">
                  <h3>{event.reason.replaceAll('_', ' ')}</h3>
                  <p>
                    {event.method} · {event.route.replaceAll('_', ' ')} · HTTP{' '}
                    {event.status}
                  </p>
                </div>
                <time dateTime={event.time}>
                  {new Date(event.time).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  return (
    <section className="list-panel">
      <div className="list-toolbar">
        <h2>Registry activity</h2>
        <span className="muted">Last 200 successful local changes</span>
      </div>
      {activity.length === 0 ? (
        <div className="empty-state">
          <Icon name="activity" size={28} />
          <h2>No registry changes yet</h2>
          <p>
            Successful local profile changes will appear here. Refused requests
            are recorded separately on the Security refusals tab; no request
            payloads are stored.
          </p>
        </div>
      ) : (
        <ul className="activity-list single-line">
          {[...activity].reverse().map((event) => (
            <li key={event.id}>
              <Icon name="check" size={18} />
              <div className="row-main">
                <h3>{event.operation.replaceAll('_', ' ')}</h3>
                <span className="activity-meta">
                  Registry revision {event.priorRevision} → {event.newRevision}
                </span>
              </div>
              <time dateTime={event.time}>
                {new Date(event.time).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
