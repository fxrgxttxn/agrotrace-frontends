import { afterNextRender, DestroyRef, inject, Injectable, Injector } from '@angular/core';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';

export function pathnameOf(url: string): string {
  return url.split(/[?#]/, 1)[0] || '/';
}

@Injectable({ providedIn: 'root' })
export class RouteFocusService {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private last: string | null = null;
  private skip: string | null = null;
  private title: HTMLElement | null = null;
  private away = false;

  constructor() {
    const sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart && this.last !== null && pathnameOf(e.url) !== this.last)
        this.away = true;
      else if (e instanceof NavigationEnd) this.arrived(pathnameOf(e.urlAfterRedirects));
      else if (
        e instanceof NavigationError ||
        e instanceof NavigationSkipped ||
        (e instanceof NavigationCancel &&
          e.code !== NavigationCancellationCode.Redirect &&
          e.code !== NavigationCancellationCode.SupersededByNewNavigation)
      )
        this.away = false;
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  skipNext(pathname: string): void {
    this.skip = pathnameOf(pathname);
  }

  register(title: HTMLElement): void {
    this.title = title;
  }

  unregister(title: HTMLElement): void {
    if (this.title === title) this.title = null;
  }

  private arrived(pathname: string): void {
    if (this.last === null) {
      this.last = pathname;
      return;
    }
    const away = this.away;
    this.away = false;
    if (this.last === pathname && !away) return;
    this.last = pathname;
    const skipped = this.skip === pathname;
    this.skip = null;
    globalThis.scrollTo?.(0, 0);
    if (skipped) return;
    afterNextRender(() => this.title?.focus({ preventScroll: true }), { injector: this.injector });
  }
}
