import { describe, expect, it } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  readTheme,
  setTheme,
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
    setTheme('dark', root, storage);
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(root.attributes.get('data-theme')).toBe('dark');
  });

  it('does not throw when the storage throws, and still applies', () => {
    const root = fakeRoot();
    expect(readTheme(throwingStorage)).toBe('system');
    expect(() => setTheme('dark', root, throwingStorage)).not.toThrow();
    expect(root.attributes.get('data-theme')).toBe('dark');
  });
});
