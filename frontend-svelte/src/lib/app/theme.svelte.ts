// Theme (spec §9.3, README «Темы»): «системная» (default) leaves `<html>` without `data-theme` and the CSS follows
// `prefers-color-scheme`; «светлая»/«тёмная» set `data-theme`. The choice is a per-browser convenience kept in
// localStorage (every access guarded: storage may be unavailable).

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'agrotrace-theme';

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
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
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

/** The current choice as runes state (the profile's switch). */
class Theme {
  choice = $state<ThemeChoice>('system');

  /** Reads the stored choice and applies it (start-up, before the first render). */
  load(): void {
    this.choice = readTheme();
    applyTheme(this.choice);
  }

  set(next: ThemeChoice): void {
    this.choice = next;
    storeTheme(next);
    applyTheme(next);
  }
}

export const theme = new Theme();
