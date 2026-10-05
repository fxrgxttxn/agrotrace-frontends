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
  } catch {}
}

class Theme {
  choice = $state<ThemeChoice>('system');

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
