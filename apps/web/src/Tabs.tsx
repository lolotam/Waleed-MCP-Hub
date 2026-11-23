import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon.js';
import {
  visibleTabs,
  type Capabilities,
  type EntryNode,
  type PillNode,
  type TabNode,
} from './navigation.js';

export const TAB_PANEL_ID = 'tab-panel';
export const tabId = (entry: string, tab: string) => `tab-${entry}-${tab}`;

// The tab row under the top bar. It is a tab list: one tab has the focus, the
// arrow keys, Home and End move between the tabs and open them.
export function TabRow({
  entry,
  tabs,
  current,
  open,
}: {
  entry: EntryNode;
  tabs: TabNode[];
  current: string | undefined;
  open: (tab: string) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const target =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = tabs[target]!;
    document.getElementById(tabId(entry.id, next.id))?.focus();
    open(next.id);
  }
  return (
    <div className="tab-row">
      <div role="tablist" aria-label={`${entry.label} pages`}>
        {tabs.map((tab, index) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              id={tabId(entry.id, tab.id)}
              type="button"
              role="tab"
              className="tab"
              aria-selected={selected}
              aria-controls={TAB_PANEL_ID}
              tabIndex={selected ? 0 : -1}
              onClick={() => open(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <Icon name={tab.icon} size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The pills under a tab. A pill is a link to its own address, so Back works
// and nothing here is a radio. Its name stays its text.
export function PillRow({
  label,
  pills,
  current,
  href,
}: {
  label: string;
  pills: PillNode[];
  current: string | undefined;
  href: (pill: string) => string;
}) {
  return (
    <div className="pill-row" role="group" aria-label={label}>
      {pills.map((pill) => (
        <a
          key={pill.id}
          className="add-pill"
          href={href(pill.id)}
          aria-current={pill.id === current ? 'true' : undefined}
        >
          <Icon name={pill.icon} size={14} />
          {pill.label}
        </a>
      ))}
    </div>
  );
}

// Wraps the content under the tab row. With tabs it is the labelled panel of
// the current tab; without tabs it is only a wrapper.
export function TabPanel({
  entry,
  capabilities,
  current,
  children,
}: {
  entry: EntryNode;
  capabilities: Capabilities;
  current: string | undefined;
  children: ReactNode;
}) {
  if (visibleTabs(entry, capabilities).length < 2) return <>{children}</>;
  return (
    <div
      id={TAB_PANEL_ID}
      role="tabpanel"
      aria-labelledby={current ? tabId(entry.id, current) : undefined}
    >
      {children}
    </div>
  );
}
