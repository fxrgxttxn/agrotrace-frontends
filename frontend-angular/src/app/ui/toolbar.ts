import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  DestroyRef,
  Directive,
  effect,
  inject,
  input,
  output,
  signal,
  TemplateRef,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { t } from '../i18n';

/** Typing in the search field is sent this long after the last key (one request, one history entry per pause). */
export const SEARCH_INPUT_DELAY_MS = 300;

const WIDE = '(min-width: 768px)';

/** `true` from 768 px (the tablet and desktop layouts), following the viewport. Create it in an injection context. */
export function injectWide(): () => boolean {
  const mq = window.matchMedia(WIDE);
  const wide = signal(mq.matches);
  const on = () => wide.set(mq.matches);
  mq.addEventListener('change', on);
  inject(DestroyRef).onDestroy(() => mq.removeEventListener('change', on));
  return wide.asReadonly();
}

export interface ToolbarSearch {
  /** `aria-label` of the field, e.g. «Поиск партий». */
  label: string;
  placeholder: string;
  /** The value in the URL. */
  value: string;
}

/** The filters of a toolbar: `<ng-template atToolbarFilters>…at-field…</ng-template>`. */
@Directive({ selector: 'ng-template[atToolbarFilters]', standalone: true })
export class ToolbarFiltersDirective {
  readonly template = inject(TemplateRef);
}

/** `at-page__toolbar` (README «Страница»): a search field and the filters. On ≥ 768 px the `details` is always open
 * (its `summary` is hidden by CSS); below that the `summary` is the «Фильтры» button with the count of chosen
 * filters — the count and its hidden prefix are left out while nothing is chosen. */
@Component({
  selector: 'div.at-page__toolbar',
  standalone: true,
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (search(); as s) {
      <div class="at-page__search">
        <svg aria-hidden="true"><use href="#i-search"></use></svg>
        <input
          class="at-input"
          type="search"
          [attr.placeholder]="s.placeholder"
          [attr.aria-label]="s.label"
          [value]="text()"
          (input)="type($any($event.target).value)"
        />
      </div>
    }
    @if (filters(); as f) {
      <details class="at-page__filters" [open]="open()" (toggle)="toggled($event)">
        <!-- prettier-ignore -->
        <summary class="at-page__filters-toggle"
          >{{ t('filters.toggle') }}@if (count() > 0) {<span class="at-visually-hidden">{{ t('filters.selected') }}</span
            >{{ ' ' }}<span class="at-page__filters-count">{{ count() }}</span>}</summary
        >
        <div class="at-page__filters-body"><ng-container *ngTemplateOutlet="f.template" /></div>
      </details>
    }
    @if (note()) {
      <p class="at-page__note">{{ note() }}</p>
    }`,
})
export class PageToolbarComponent {
  protected readonly t = t;
  readonly search = input<ToolbarSearch | undefined>(undefined);
  readonly count = input(0);
  /** A short fact next to «Фильтры» (`at-page__note`, shown by CSS below 768 px only). */
  readonly note = input<string | undefined>(undefined);
  /** The typed search text, sent after a pause. */
  readonly searchChange = output<string>();

  protected readonly filters = contentChild(ToolbarFiltersDirective);
  private readonly wide = injectWide();
  private readonly opened = signal(false);
  protected readonly open = computed(() => this.wide() || this.opened());
  protected readonly text = signal('');
  private sent = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // A URL change from elsewhere (back button, «Сбросить фильтры») replaces the text.
    effect(
      () => {
        const external = this.search()?.value ?? '';
        untracked(() => {
          if (external !== this.sent) {
            this.sent = external;
            this.text.set(external);
          }
        });
      },
      { allowSignalWrites: true },
    );
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  protected type(value: string): void {
    this.text.set(value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.sent = value;
      this.searchChange.emit(value);
    }, SEARCH_INPUT_DELAY_MS);
  }

  protected toggled(e: Event): void {
    if (!this.wide()) this.opened.set((e.target as HTMLDetailsElement).open);
  }
}
