import { Directive } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** The router outlet on an `<ng-container atOutlet />`: the routed page is inserted with no `<router-outlet>` element
 * next to it, so the shell's DOM is exactly the README's (`<main class="at-shell__main"><div class="at-page">`). The
 * routed components' hosts are the README elements themselves (selectors `div.at-page`, `main.at-page`,
 * `div.at-shell`: Angular creates a routed component's host from its selector, class included). */
@Directive({ selector: 'ng-container[atOutlet]', standalone: true, exportAs: 'outlet' })
export class OutletDirective extends RouterOutlet {}
