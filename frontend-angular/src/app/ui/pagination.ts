import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { t } from '../i18n';
import { LinkDirective } from './link';

/** Page numbers to show: first, last, current ± 1; `null` is a gap (a gap of exactly one page shows that page). */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const out: (number | null)[] = [];
  let prev = 0;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (p - prev > 1) out.push(p - prev === 2 ? p - 1 : null);
    out.push(p);
    prev = p;
  }
  return out;
}

/** `at-pagination` (README «Пагинация»): links keep the rest of the URL state (`hrefFor` builds them); no previous /
 * next page — a disabled button instead of the link. */
@Component({
  selector: 'nav.at-pagination',
  standalone: true,
  imports: [LinkDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="at-pagination__summary">
      {{ t('ui.pageSummary', { from: from(), to: to(), total: total() }) }}
    </p>
    <ul class="at-pagination__pages">
      <li>
        @if (page() > 1) {
          <a class="at-pagination__item" [to]="hrefFor()(page() - 1)" [attr.aria-label]="t('ui.prevPage')"
            ><svg aria-hidden="true"><use href="#i-chevron-left"></use></svg
          ></a>
        } @else {
          <button class="at-pagination__item" type="button" [attr.aria-label]="t('ui.prevPage')" disabled>
            <svg aria-hidden="true"><use href="#i-chevron-left"></use></svg>
          </button>
        }
      </li>
      @for (p of window(); track $index) {
        <li>
          @if (p === null) {
            <span class="at-pagination__gap" aria-hidden="true">…</span>
          } @else {
            <a
              class="at-pagination__item"
              [to]="hrefFor()(p)"
              [attr.aria-current]="p === page() ? 'page' : null"
              >{{ p }}</a
            >
          }
        </li>
      }
      <li>
        @if (page() < pages()) {
          <a class="at-pagination__item" [to]="hrefFor()(page() + 1)" [attr.aria-label]="t('ui.nextPage')"
            ><svg aria-hidden="true"><use href="#i-chevron-right"></use></svg
          ></a>
        } @else {
          <button class="at-pagination__item" type="button" [attr.aria-label]="t('ui.nextPage')" disabled>
            <svg aria-hidden="true"><use href="#i-chevron-right"></use></svg>
          </button>
        }
      </li>
    </ul>`,
  host: { '[attr.aria-label]': "t('ui.pages')" },
})
export class PaginationComponent {
  protected readonly t = t;
  /** 1-based, as in the contract. */
  readonly page = input.required<number>();
  readonly size = input.required<number>();
  readonly total = input.required<number>();
  readonly hrefFor = input.required<(page: number) => string>();
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.size())));
  protected readonly from = computed(() => (this.total() === 0 ? 0 : (this.page() - 1) * this.size() + 1));
  protected readonly to = computed(() => Math.min(this.total(), this.page() * this.size()));
  protected readonly window = computed(() => pageWindow(this.page(), this.pages()));
}
