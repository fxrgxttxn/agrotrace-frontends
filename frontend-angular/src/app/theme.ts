// Theme (spec §9.3, README «Темы»): «системная» (default) leaves `<html>` without `data-theme` and the CSS follows
// `prefers-color-scheme`; «светлая»/«тёмная» set `data-theme`. The choice is a per-browser convenience kept in
// localStorage (every access guarded: storage may be unavailable).

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'agrotrace-theme';

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
