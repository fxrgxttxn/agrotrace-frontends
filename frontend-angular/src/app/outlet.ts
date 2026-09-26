import { Directive, effect, inject, input, type ComponentRef } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavigationService } from './navigation';

/** The router outlet on an `<ng-container atOutlet="shell|root" />`: the routed page is inserted with no
 * `<router-outlet>` element next to it, so the shell's DOM is exactly the README's (`<main class="at-shell__main"><div
 * class="at-page">`). The routed components' hosts are the README elements themselves (selectors `div.at-page`,
 * `main.at-page`, `div.at-shell`: Angular creates a routed component's host from its selector, class included).
 * While a page chunk loads into this outlet (FM10) the current page is `hidden` — the loading page stands before it —
 * and shown again if the navigation is cancelled. */
@Directive({ selector: 'ng-container[atOutlet]', standalone: true, exportAs: 'outlet' })
export class OutletDirective extends RouterOutlet {
  readonly level = input<'shell' | 'root' | ''>('', { alias: 'atOutlet' });
  private readonly navigation = inject(NavigationService);

  constructor() {
    super();
    effect(() => {
      const loadingIn = this.navigation.loadingIn();
      const hide = loadingIn !== null && loadingIn === this.level();
      const ref = (this as unknown as { activated: ComponentRef<unknown> | null }).activated;
      const host = ref?.location.nativeElement as HTMLElement | undefined;
      if (!host) return;
      if (hide) host.setAttribute('hidden', '');
      else host.removeAttribute('hidden');
    });
  }
}
