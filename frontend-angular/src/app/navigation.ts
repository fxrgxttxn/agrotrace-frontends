import { DestroyRef, inject, Injectable, Injector, signal } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  RouteConfigLoadStart,
  Router,
  type Route,
} from '@angular/router';
import { pathnameOf } from './route-focus';
import { SessionService } from './session';

export const SHELL_PAGE_LOADERS = new WeakSet<object>();

@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly router = inject(Router);
  readonly pathname = signal(pathnameOf(this.router.url));
  readonly loadingIn = signal<'shell' | 'root' | 'enter-shell' | null>(null);
  shellActive = false;
  private readonly injector = inject(Injector);

  private whereLoading(route: Route): 'shell' | 'root' | 'enter-shell' {
    if (!isShellPage(route)) return 'root';
    if (this.shellActive) return 'shell';
    return this.injector.get(SessionService).status() === 'authenticated' ? 'enter-shell' : 'root';
  }

  constructor() {
    const sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) this.pathname.set(pathnameOf(e.url));
      else if (e instanceof RouteConfigLoadStart) this.loadingIn.set(this.whereLoading(e.route));
      else if (e instanceof NavigationEnd) {
        this.pathname.set(pathnameOf(e.urlAfterRedirects));
        this.loadingIn.set(null);
      } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
        if (!(e instanceof NavigationCancel && e.code === 0)) {
          this.pathname.set(pathnameOf(this.router.url));
          this.loadingIn.set(null);
        }
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }
}

function isShellPage(route: Route): boolean {
  return route.loadComponent !== undefined && SHELL_PAGE_LOADERS.has(route.loadComponent);
}
