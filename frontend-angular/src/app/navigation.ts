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
  /** Where the loading page stands while a lazy page chunk loads: in the shell's main (`shell`), in a shell frame the
   * root draws when a signed-in user enters the shell from a screen outside it (`enter-shell`, FM11), at the root
   * (`root`); `null` — nothing loads. */
  readonly loadingIn = signal<'shell' | 'root' | 'enter-shell' | null>(null);
  /** The cabinet shell is on screen (set by it). */
  shellActive = false;
  private readonly injector = inject(Injector);

  private whereLoading(route: Route): 'shell' | 'root' | 'enter-shell' {
    if (!isShellPage(route)) return 'root';
    if (this.shellActive) return 'shell';
    // resolved lazily: the session service itself depends on the router
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
