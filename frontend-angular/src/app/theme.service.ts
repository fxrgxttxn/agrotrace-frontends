import { Injectable, signal } from '@angular/core';
import { applyTheme, readTheme, storeTheme, type ThemeChoice } from './theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly choice = signal<ThemeChoice>(readTheme());

  set(next: ThemeChoice): void {
    this.choice.set(next);
    storeTheme(next);
    applyTheme(next);
  }
}
