import { Injectable, signal } from '@angular/core';
import { applyTheme, readTheme, storeTheme, type ThemeChoice } from './theme';

/** The current choice as a signal; `set` stores and applies it. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly choice = signal<ThemeChoice>(readTheme());

  set(next: ThemeChoice): void {
    this.choice.set(next);
    storeTheme(next);
    applyTheme(next);
  }
}
