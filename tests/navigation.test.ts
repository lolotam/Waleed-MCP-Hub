import { describe, expect, it } from 'vitest';
import {
  defaultPlace,
  entries,
  formatPlace,
  parsePlace,
  readLaunchFragment,
  resolvePlace,
  visiblePills,
  visibleTabs,
  type Capabilities,
  type EntryNode,
  type Place,
  type TabNode,
} from '../apps/web/src/navigation.js';

// Every leaf of the tree is one view: a pill, else a tab, else an entry.
function views(): Array<{ place: Place; hidden: boolean }> {
  const list: Array<{ place: Place; hidden: boolean }> = [];
  for (const entry of entries as readonly EntryNode[]) {
    if (entry.tabs.length === 0) {
      list.push({
        place: { entry: entry.id as Place['entry'] },
        hidden: false,
      });
      continue;
    }
    for (const tab of entry.tabs) {
      const base = { entry: entry.id as Place['entry'], tab: tab.id };
      if (!tab.pills) {
        list.push({ place: base, hidden: !!tab.capability });
        continue;
      }
      for (const pill of tab.pills)
        list.push({
          place: { ...base, pill: pill.id },
          hidden: !!tab.capability || !!pill.capability,
        });
    }
  }
  return list;
}

const spec = [
  '#/connectors',
  '#/connectors/add/import',
  '#/connectors/add/manual',
  '#/connectors/add/agents',
  '#/connectors/add/discover',
  '#/agents',
  '#/profiles',
  '#/activity/registry',
  '#/activity/refusals',
  '#/settings/runtime',
  '#/settings/updates',
  '#/settings/recovery',
];

describe('navigation tree', () => {
  it('keeps the five sidebar entries in their order', () => {
    expect(entries.map((entry) => entry.label)).toEqual([
      'Connectors',
      'Agents',
      'Profiles',
      'Activity',
      'Settings',
    ]);
  });

  it('has every view exactly once, at the addresses of the spec', () => {
    const addresses = views().map((view) => formatPlace(view.place));
    expect(new Set(addresses).size).toBe(addresses.length);
    expect([...addresses].sort()).toEqual([...spec].sort());
  });

  it('gives every tab and pill an identifier that is unique among its siblings', () => {
    for (const entry of entries as readonly EntryNode[]) {
      const tabIds = entry.tabs.map((tab) => tab.id);
      expect(new Set(tabIds).size).toBe(tabIds.length);
      for (const tab of entry.tabs as readonly TabNode[]) {
        const pillIds = (tab.pills ?? []).map((pill) => pill.id);
        expect(new Set(pillIds).size).toBe(pillIds.length);
      }
    }
  });

  it('keeps a sibling that no capability can hide', () => {
    for (const entry of entries as readonly EntryNode[]) {
      if (entry.tabs.some((tab) => tab.capability))
        expect(entry.tabs.some((tab) => !tab.capability)).toBe(true);
      for (const tab of entry.tabs as readonly TabNode[]) {
        if (tab.pills?.some((pill) => pill.capability))
          expect(tab.pills.some((pill) => !pill.capability)).toBe(true);
      }
    }
  });

  it('shows an always visible tab and pill when every capability is off', () => {
    const none: Capabilities = {};
    for (const entry of entries as readonly EntryNode[]) {
      const tabs = visibleTabs(entry, none);
      if (entry.tabs.length) expect(tabs.length).toBeGreaterThan(0);
      for (const tab of tabs)
        if (tab.pills)
          expect(visiblePills(tab, none).length).toBeGreaterThan(0);
    }
  });

  it('shows everything while the capabilities are not known yet', () => {
    const settings = entries.find((entry) => entry.id === 'settings')!;
    expect(visibleTabs(settings, null).map((tab) => tab.id)).toEqual([
      'runtime',
      'updates',
      'recovery',
    ]);
    expect(
      visibleTabs(settings, { appUpdates: false }).map((tab) => tab.id),
    ).toEqual(['runtime', 'recovery']);
  });
});

describe('addresses', () => {
  it('formats and parses every view back to itself', () => {
    for (const { place } of views())
      expect(parsePlace(formatPlace(place))).toEqual(place);
    for (const address of spec)
      expect(formatPlace(parsePlace(address))).toBe(address);
  });

  it('reads the first tab and pill of a bare entry address', () => {
    expect(parsePlace('#/connectors')).toEqual({
      entry: 'connectors',
      tab: 'all',
    });
    expect(parsePlace('#/connectors/add')).toEqual({
      entry: 'connectors',
      tab: 'add',
      pill: 'import',
    });
    expect(parsePlace('#/settings')).toEqual({
      entry: 'settings',
      tab: 'runtime',
    });
    expect(parsePlace('#/activity')).toEqual({
      entry: 'activity',
      tab: 'registry',
    });
  });

  it('falls back to Connectors for an unknown or malformed address', () => {
    for (const hash of [
      '',
      '#',
      '#/',
      '#//',
      '#main',
      '#launch=abc',
      '#/nonsense',
      '#/nonsense/add/import',
      '#/%E0%A4%A',
      '#connectors',
      '/connectors',
      '#/__proto__',
      '#/constructor/prototype',
    ])
      expect(parsePlace(hash)).toEqual(defaultPlace);
    expect(defaultPlace).toEqual({ entry: 'connectors', tab: 'all' });
  });

  it('falls back to the first tab or pill of a known entry', () => {
    expect(parsePlace('#/settings/nonsense')).toEqual({
      entry: 'settings',
      tab: 'runtime',
    });
    expect(parsePlace('#/connectors/add/nonsense')).toEqual({
      entry: 'connectors',
      tab: 'add',
      pill: 'import',
    });
    expect(parsePlace('#/profiles/anything')).toEqual({ entry: 'profiles' });
  });

  it('ignores extra segments, as the address of a connector will add them', () => {
    expect(parsePlace('#/connectors/all/connector-id/overview/extra')).toEqual({
      entry: 'connectors',
      tab: 'all',
    });
    expect(parsePlace('#/connectors/add/manual/more')).toEqual({
      entry: 'connectors',
      tab: 'add',
      pill: 'manual',
    });
    expect(parsePlace('#/agents/x/y/z')).toEqual({ entry: 'agents' });
  });

  it('reads an address that is not in the canonical case or encoding', () => {
    expect(parsePlace('#/Connectors/ADD/%6Danual')).toEqual({
      entry: 'connectors',
      tab: 'add',
      pill: 'manual',
    });
  });
});

describe('capability fallback', () => {
  it('moves a hidden pill to the first visible sibling', () => {
    expect(
      resolvePlace(parsePlace('#/connectors/add/agents'), {
        agentCloning: false,
        discovery: true,
      }),
    ).toEqual({ entry: 'connectors', tab: 'add', pill: 'import' });
    expect(
      resolvePlace(parsePlace('#/connectors/add/discover'), {
        agentCloning: true,
        discovery: false,
      }),
    ).toEqual({ entry: 'connectors', tab: 'add', pill: 'import' });
  });

  it('moves a hidden tab to the first visible tab', () => {
    expect(
      resolvePlace(parsePlace('#/settings/updates'), { appUpdates: false }),
    ).toEqual({ entry: 'settings', tab: 'runtime' });
  });

  it('keeps a visible place and any place while the capabilities are unknown', () => {
    const updates = parsePlace('#/settings/updates');
    expect(resolvePlace(updates, { appUpdates: true })).toEqual(updates);
    expect(resolvePlace(updates, null)).toEqual(updates);
  });
});

describe('launch fragment', () => {
  const token = 'a'.repeat(64);

  it('takes the token out of the launch address and leaves no hash', () => {
    expect(readLaunchFragment(`#launch=${token}`)).toEqual({
      token,
      hash: '',
    });
  });

  it('keeps a page hash and takes the token out of a shared fragment', () => {
    expect(readLaunchFragment(`#/profiles&launch=${token}`)).toEqual({
      token,
      hash: '#/profiles',
    });
    expect(
      readLaunchFragment(`#launch=${token}&/connectors/add/manual`),
    ).toEqual({ token, hash: '#/connectors/add/manual' });
  });

  it('keeps a page hash that has no token', () => {
    expect(readLaunchFragment('#/activity/refusals')).toEqual({
      token: null,
      hash: '#/activity/refusals',
    });
  });

  it('returns nothing for an empty fragment', () => {
    expect(readLaunchFragment('')).toEqual({ token: null, hash: '' });
    expect(readLaunchFragment('#')).toEqual({ token: null, hash: '' });
  });

  it('never leaves a token in the hash, even when it is repeated or empty', () => {
    const result = readLaunchFragment(`#launch=${token}&launch=other&/agents`);
    expect(result).toEqual({ token, hash: '#/agents' });
    expect(result.hash).not.toContain('launch');
    expect(readLaunchFragment('#launch=')).toEqual({ token: null, hash: '' });
  });
});
