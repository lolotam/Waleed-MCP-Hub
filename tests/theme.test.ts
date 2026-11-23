import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  THEME_COLORS,
  THEME_STORAGE_KEY,
  applyTheme,
  applyThemeColor,
  readTheme,
  setTheme,
  type ThemeColorTag,
  type ThemeRoot,
  type ThemeStorage,
} from '../apps/web/src/theme.js';

// Plain fakes: the unit tests run in Node, without a DOM.
function fakeRoot(): ThemeRoot & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  };
}

function fakeStorage(initial: Record<string, string> = {}): ThemeStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

const throwingStorage: ThemeStorage = {
  getItem() {
    throw new Error('storage blocked');
  },
  setItem() {
    throw new Error('storage blocked');
  },
};

function fakeTag(media: string): ThemeColorTag & { content: string } {
  const tag = {
    content: '',
    getAttribute: (name: string) => (name === 'media' ? media : null),
    setAttribute: (name: string, value: string) => {
      if (name === 'content') tag.content = value;
    },
  };
  return tag;
}

describe('theme choice', () => {
  it('defaults to system when nothing or something unknown is saved', () => {
    expect(readTheme(fakeStorage())).toBe('system');
    expect(readTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' }))).toBe(
      'system',
    );
  });

  it('reads a saved choice', () => {
    expect(readTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe(
      'dark',
    );
  });

  it('sets data-theme for dark and light', () => {
    const root = fakeRoot();
    applyTheme('dark', root);
    expect(root.attributes.get('data-theme')).toBe('dark');
    applyTheme('light', root);
    expect(root.attributes.get('data-theme')).toBe('light');
  });

  it('removes data-theme for system', () => {
    const root = fakeRoot();
    applyTheme('dark', root);
    applyTheme('system', root);
    expect(root.attributes.has('data-theme')).toBe(false);
  });

  it('saves the choice it applies', () => {
    const root = fakeRoot();
    const storage = fakeStorage();
    setTheme('dark', root, storage, []);
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(root.attributes.get('data-theme')).toBe('dark');
  });

  it('gives both window frame tags the colour of an explicit choice', () => {
    const light = fakeTag('(prefers-color-scheme: light)');
    const dark = fakeTag('(prefers-color-scheme: dark)');
    applyThemeColor('dark', [light, dark]);
    expect([light.content, dark.content]).toEqual([
      THEME_COLORS.dark,
      THEME_COLORS.dark,
    ]);
    applyThemeColor('system', [light, dark]);
    expect([light.content, dark.content]).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.dark,
    ]);
  });

  it('keeps the early script on the same key and values', () => {
    const script = readFileSync('apps/web/public/theme-init.js', 'utf8');
    expect(script).toContain(`getItem('${THEME_STORAGE_KEY}')`);
    expect(script).toContain("choice === 'light' || choice === 'dark'");
  });

  it('does not throw when the storage throws, and still applies', () => {
    const root = fakeRoot();
    expect(readTheme(throwingStorage)).toBe('system');
    expect(() => setTheme('dark', root, throwingStorage, [])).not.toThrow();
    expect(root.attributes.get('data-theme')).toBe('dark');
  });
});
