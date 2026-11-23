// The appearance choice: Light, Dark, or System (follow Windows). Only Light
// and Dark write `data-theme`; System removes it so the stylesheet's
// `prefers-color-scheme` rule decides.
export type ThemeChoice = 'light' | 'dark' | 'system';

export const themeChoices: readonly { id: ThemeChoice; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

export const THEME_STORAGE_KEY = 'wmh-theme-v1';

// The parts of `localStorage` and of the root element this module needs, so
// a test can pass plain fakes.
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

// Reading `localStorage` can throw (blocked site data), so a missing or
// unreadable store is the same as no saved choice.
function browserStorage(): ThemeStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readTheme(storage = browserStorage()): ThemeChoice {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(
  choice: ThemeChoice,
  root: ThemeRoot = document.documentElement,
): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

// Applies and remembers a choice. A store that cannot be written still
// leaves the choice applied for this page.
export function setTheme(
  choice: ThemeChoice,
  root: ThemeRoot = document.documentElement,
  storage = browserStorage(),
): void {
  applyTheme(choice, root);
  try {
    storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Not remembered; the page still shows the choice.
  }
}

// Runs before React renders so the first paint already has the saved theme.
export function applyStoredTheme(): void {
  applyTheme(readTheme());
}
