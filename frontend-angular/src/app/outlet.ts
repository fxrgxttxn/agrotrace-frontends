import { DestroyRef, Directive, inject, input, type ComponentRef } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  RouteConfigLoadStart,
  Router,
  RouterOutlet,
} from '@angular/router';
import { NavigationService } from './navigation';

/** The router outlet on an `<ng-container atOutlet="shell|root" />`: the routed page is inserted with no
 * `<router-outlet>` element next to it, so the shell's DOM is exactly the README's (`<main class="at-shell__main"><div
 * class="at-page">`). The routed components' hosts are the README elements themselves (selectors `div.at-page`,
 * `main.at-page`, `div.at-shell`: Angular creates a routed component's host from its selector, class included).
 * While a page chunk loads into this outlet (FM10/FM11) the page that was on screen when the load started is hidden
 * (`hidden` + `inert` + `display: none` — `hidden` alone loses to `.at-shell`'s grid; a `main#main` lends its id to the
 * page shown meanwhile) — the loading page stands before it — and shown again if the navigation does not replace it.
 * The page being hidden is decided at the load start, never later, so a quickly activated new page is never hidden. */
@Directive({ selector: 'ng-container[atOutlet]', standalone: true, exportAs: 'outlet' })
export class OutletDirective extends RouterOutlet {
  readonly level = input<'shell' | 'root' | ''>('', { alias: 'atOutlet' });
  private readonly navigation = inject(NavigationService);
  private hidden: { host: HTMLElement; lentId: boolean } | null = null;

  constructor() {
    super();
    // Subscribed after NavigationService (it is created first), so `loadingIn` is already set for this event.
    const sub = inject(Router).events.subscribe((e) => {
      if (e instanceof RouteConfigLoadStart) {
        const loadingIn = this.navigation.loadingIn();
        const level = this.level();
        if (loadingIn === level || (loadingIn === 'enter-shell' && level === 'root')) this.hide();
      } else if (
        e instanceof NavigationEnd ||
        e instanceof NavigationCancel ||
        e instanceof NavigationError
      ) {
        this.show();
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  private hide(): void {
    const ref = (this as unknown as { activated: ComponentRef<unknown> | null }).activated;
    const host = ref?.location.nativeElement as HTMLElement | undefined;
    if (!host || this.hidden) return;
    const lentId = host.id === 'main';
    host.setAttribute('hidden', '');
    host.setAttribute('inert', '');
    host.style.setProperty('display', 'none');
    if (lentId) host.removeAttribute('id');
    this.hidden = { host, lentId };
  }

  private show(): void {
    const h = this.hidden;
    this.hidden = null;
    if (!h) return;
    h.host.removeAttribute('hidden');
    h.host.removeAttribute('inert');
    h.host.style.removeProperty('display');
    if (h.host.getAttribute('style') === '') h.host.removeAttribute('style');
    if (h.lentId) h.host.id = 'main';
  }
}
