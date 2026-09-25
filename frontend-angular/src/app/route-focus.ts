import { afterNextRender, DestroyRef, inject, Injectable, Injector } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

// Focus on route change (ruling F4, design-system README «Фокус при смене маршрута»): after every client-side change of
// the pathname — not on the first load of the app, redirects at start-up included — focus moves to the new page's
// `h1.at-page__title` once it is rendered. Query-only changes do not move focus. A pick in the «Ещё» menu keeps its own
// rule (focus back on «Ещё»): it announces the target path beforehand and that navigation skips the move. The page
// scrolls to the top on every pathname change.

export function pathnameOf(url: string): string {
  return url.split(/[?#]/, 1)[0] || '/';
}

@Injectable({ providedIn: 'root' })
export class RouteFocusService {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  /** Pathname of the last completed navigation; `null` until the first one (first load). */
  private last: string | null = null;
  /** A navigation whose focus is handled by its origin (the «Ещё» menu). */
  private skip: string | null = null;
  /** Title of the page rendered last (registered by `div.at-page__header`). */
  private title: HTMLElement | null = null;

  constructor() {
    const sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.arrived(pathnameOf(e.urlAfterRedirects));
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  /** Called by a menu that restores focus itself, right before it navigates to `pathname`. */
  skipNext(pathname: string): void {
    this.skip = pathnameOf(pathname);
  }

  /** The heading of the page that is being rendered. */
  register(title: HTMLElement): void {
    this.title = title;
  }

  unregister(title: HTMLElement): void {
    if (this.title === title) this.title = null;
  }

  private arrived(pathname: string): void {
    if (this.last === null) {
      this.last = pathname; // first load: focus stays where the browser put it
      return;
    }
    if (this.last === pathname) return;
    this.last = pathname;
    const skipped = this.skip === pathname;
    this.skip = null;
    globalThis.scrollTo?.(0, 0);
    if (skipped) return;
    // The new page's view is checked after the navigation ends: focus its title once it is on screen.
    afterNextRender(() => this.title?.focus({ preventScroll: true }), { injector: this.injector });
  }
}
