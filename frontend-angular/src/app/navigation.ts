import { DestroyRef, inject, Injectable, signal } from '@angular/core';
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

/** `loadComponent` of the routes that render inside the cabinet shell (filled by app.routes.ts; the router copies
 * route objects, their loader functions stay the same). */
export const SHELL_PAGE_LOADERS = new WeakSet<object>();

// Navigation state for the screens (ruling FM10, as React's Suspense): the URL is updated at the start of a navigation
// (`urlUpdateStrategy: 'eager'`), `pathname` follows it at once (menu `aria-current`), and while a page chunk loads the
// outlet that will show it renders the aria-busy loading page instead of the previous page. A cancelled navigation
// (guard answered `false`) returns everything to the current page.

@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly router = inject(Router);
  /** Pathname being shown or navigated to. */
  readonly pathname = signal(pathnameOf(this.router.url));
  /** Which outlet shows the loading page while a lazy page chunk loads (`null` — none). */
  readonly loadingIn = signal<'shell' | 'root' | null>(null);
  /** The cabinet shell is on screen (set by it). */
  shellActive = false;

  constructor() {
    const sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) this.pathname.set(pathnameOf(e.url));
      else if (e instanceof RouteConfigLoadStart)
        this.loadingIn.set(this.shellActive && isShellPage(e.route) ? 'shell' : 'root');
      else if (e instanceof NavigationEnd) {
        this.pathname.set(pathnameOf(e.urlAfterRedirects));
        this.loadingIn.set(null);
      } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
        // a redirect continues in a new navigation; anything else leaves the current page
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
