import type { Bootstrap } from '@waleed/contracts';
import type { IconName } from './Icon.js';

// The navigation of the app as data: five sidebar entries, their tabs and the
// pills under one tab. This module is pure. It never reads `window` or
// `document`, so the shape can be tested in Node and the shell only draws it.

export type Capability = keyof Bootstrap['capabilities'];
// While the hub has not answered there is no set, and nothing is hidden.
export type Capabilities = Partial<Record<Capability, boolean>> | null;

export interface PillNode {
  id: string;
  label: string;
  icon: IconName;
  // The capability that shows this pill. A pill without one is always shown.
  capability?: Capability;
}

export interface TabNode {
  id: string;
  label: string;
  icon: IconName;
  capability?: Capability;
  // The first tab of an entry may be the bare address of the entry.
  bare?: boolean;
  pills?: PillNode[];
}

export interface EntryNode {
  id: string;
  label: string;
  icon: IconName;
  description: string;
  tabs: TabNode[];
}

export const entries = [
  {
    id: 'connectors',
    label: 'Connectors',
    icon: 'connectors',
    description:
      'One place for your tools. Explicit control over where they run.',
    tabs: [
      { id: 'all', label: 'All connectors', icon: 'connectors', bare: true },
      {
        id: 'add',
        label: 'Add',
        icon: 'plus',
        pills: [
          { id: 'import', label: 'Paste or import', icon: 'upload' },
          { id: 'manual', label: 'Manual MCP', icon: 'edit' },
          {
            id: 'agents',
            label: 'From your agents',
            icon: 'agents',
            capability: 'agentCloning',
          },
          {
            id: 'discover',
            label: 'Discover environment',
            icon: 'search',
            capability: 'discovery',
          },
        ],
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'agents',
    description:
      'Installed, configured, and verified are three different things.',
    tabs: [],
  },
  {
    id: 'profiles',
    label: 'Profiles',
    icon: 'profiles',
    description: 'Organize tools around the way you work.',
    tabs: [],
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: 'activity',
    description: 'A local record of changes. No credentials or raw payloads.',
    tabs: [
      { id: 'registry', label: 'Registry activity', icon: 'activity' },
      { id: 'refusals', label: 'Security refusals', icon: 'shield' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'settings',
    description: 'Your machine. Your configuration. Nothing enabled silently.',
    tabs: [
      { id: 'runtime', label: 'Runtime & safeguards', icon: 'settings' },
      {
        id: 'updates',
        label: 'Updates',
        icon: 'download',
        capability: 'appUpdates',
      },
      { id: 'recovery', label: 'Recovery', icon: 'lock' },
    ],
  },
] as const satisfies readonly EntryNode[];

export type EntryId = (typeof entries)[number]['id'];

// Where the user is: an entry, and under it a tab and a pill when it has them.
export interface Place {
  entry: EntryId;
  tab?: string;
  pill?: string;
}

export function entryOf(id: EntryId): EntryNode {
  return entries.find((entry) => entry.id === id)!;
}

function shown(
  node: { capability?: Capability | undefined },
  capabilities: Capabilities,
): boolean {
  return (
    !node.capability || !capabilities || capabilities[node.capability] === true
  );
}

export function visibleTabs(
  entry: EntryNode,
  capabilities: Capabilities,
): TabNode[] {
  return entry.tabs.filter((tab) => shown(tab, capabilities));
}

export function visiblePills(
  tab: TabNode,
  capabilities: Capabilities,
): PillNode[] {
  return (tab.pills ?? []).filter((pill) => shown(pill, capabilities));
}

// The first place of an entry or of one of its tabs.
export function firstPlace(
  entry: EntryNode,
  capabilities: Capabilities,
  tabId?: string,
): Place {
  const tabs = visibleTabs(entry, capabilities);
  const tab = tabs.find((candidate) => candidate.id === tabId) ?? tabs[0];
  if (!tab) return { entry: entry.id as EntryId };
  const pill = visiblePills(tab, capabilities)[0];
  return {
    entry: entry.id as EntryId,
    tab: tab.id,
    ...(pill ? { pill: pill.id } : {}),
  };
}

// A place that names a tab or a pill the capabilities hide falls back to the
// first visible sibling. An unknown tab or pill falls back the same way.
export function resolvePlace(place: Place, capabilities: Capabilities): Place {
  const entry = entryOf(place.entry);
  const tabs = visibleTabs(entry, capabilities);
  const tab = tabs.find((candidate) => candidate.id === place.tab) ?? tabs[0];
  if (!tab) return { entry: entry.id as EntryId };
  const pills = visiblePills(tab, capabilities);
  const pill =
    pills.find((candidate) => candidate.id === place.pill) ?? pills[0];
  return {
    entry: entry.id as EntryId,
    tab: tab.id,
    ...(pill ? { pill: pill.id } : {}),
  };
}

export const defaultPlace: Place = firstPlace(entryOf('connectors'), null);

export function samePlace(left: Place, right: Place): boolean {
  return (
    left.entry === right.entry &&
    left.tab === right.tab &&
    left.pill === right.pill
  );
}

// The address of a place, for example `#/connectors/add/manual`. The first tab
// of Connectors is the bare `#/connectors`.
export function formatPlace(place: Place): string {
  const entry = entryOf(place.entry);
  const tab = entry.tabs.find((candidate) => candidate.id === place.tab) as
    TabNode | undefined;
  const parts: string[] = [entry.id];
  if (tab && !tab.bare) {
    parts.push(tab.id);
    const pill = tab.pills?.find((candidate) => candidate.id === place.pill);
    if (pill) parts.push(pill.id);
  }
  return `#/${parts.join('/')}`;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

// Read an address into a place. It never throws: anything that is not an
// address of this app is Connectors. Segments past the last known one are
// ignored, which leaves room for the address of a connector under "all".
// A tab or pill that does not exist falls back to the first one of its entry.
export function parsePlace(hash: string): Place {
  if (!hash.startsWith('#/')) return defaultPlace;
  const [entryId, tabId, pillId] = hash
    .slice(2)
    .split('/')
    .map((segment) => decode(segment).toLowerCase());
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) return defaultPlace;
  return resolvePlace(
    {
      entry: entry.id,
      ...(tabId ? { tab: tabId } : {}),
      ...(pillId ? { pill: pillId } : {}),
    },
    null,
  );
}

export interface LaunchFragment {
  // The one-time launch token, when the fragment carried one.
  token: string | null;
  // What is left of the fragment, with its `#`, or an empty string.
  hash: string;
}

// The fragment of the launch address is `#launch=<token>`. A page address can
// share it: the fragment is a list of parts joined by `&`, a part that starts
// with `launch=` is the token and the rest is the page address, so
// `#/profiles&launch=<token>` and `#launch=<token>&/profiles` both read as the
// token plus `#/profiles`. The token never stays in the returned hash.
export function readLaunchFragment(hash: string): LaunchFragment {
  const parts = hash.replace(/^#/, '').split('&');
  let token: string | null = null;
  const rest: string[] = [];
  for (const part of parts) {
    if (part.startsWith('launch=')) {
      token ??= decode(part.slice('launch='.length)) || null;
    } else if (part) rest.push(part);
  }
  return { token, hash: rest.length ? `#${rest.join('&')}` : '' };
}
