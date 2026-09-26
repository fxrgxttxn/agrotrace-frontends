import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { createT } from '@agrotrace/i18n';

// No router and no cabinet modules here: the path is matched by hand so the chunk stays small (spec §9.6; A8 fills
// the page in and holds it to ≤ 60 KB JS gzip).
const t = createT('ru');

export type PublicRoute =
  { name: 'batch'; code: string } | { name: 'complaint'; code: string } | { name: 'none' };

export function matchPublic(path: string): PublicRoute {
  const m = /^\/p\/([^/]+)(\/complaint)?\/?$/.exec(path);
  if (!m) return { name: 'none' };
  const code = decodeURIComponent(m[1]!);
  return m[2] ? { name: 'complaint', code } : { name: 'batch', code };
}

@Component({
  selector: 'at-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main class="at-page" id="main" tabindex="-1">
    <div class="at-page__header">
      <h1 class="at-page__title">{{ title }}</h1>
    </div>
    @if (route.name !== 'none') {
      <p class="at-mono">{{ route.code }}</p>
    }
  </main>`,
})
export class PublicApp {
  protected readonly route = matchPublic(location.pathname);
  protected readonly title =
    this.route.name === 'batch'
      ? t('page.publicBatch')
      : this.route.name === 'complaint'
        ? t('page.publicComplaint')
        : t('page.notFound');

  constructor() {
    // FM10: no framework version attribute in the production DOM.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    queueMicrotask(() => host.removeAttribute('ng-version'));
    document.title = `${this.title} — AgroTrace`;
  }
}
