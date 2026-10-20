import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { t } from '../app/i18n';
import { ButtonComponent } from '../app/ui/button';
import { injectThemeVersion } from '../app/ui/fullscreen';
import { currentUrl, reloadOnce } from '../reload-mark';
import { chartSummary, type Bar } from './bars';
import type { ChartView } from './echarts';

// `at-chart` (README «График»), the React app's charts/BarChart.tsx: the ECharts canvas (`role="img"` with a summary of
// every bar) and, under it, the same values as a table in a collapsed `details` (projected: the page writes the table)
// — tooltips enhance, the table is the keyboard and screen-reader view. ECharts is its own lazy chunk (the dashboard
// page does not carry it); the chart is drawn again when the theme changes (token values are read with
// getComputedStyle).

/** One request for the chart chunk per document, however many charts mount. A failed dynamic import stays failed in
 * this document (browsers keep the failed module), so it is not asked again: «Повторить» loads the page anew through
 * the reload-once guard (ruling FM15). */
let loading: Promise<typeof import('./echarts')> | null = null;
function loadCharts() {
  loading ??= import('./echarts');
  return loading;
}

type Failure = 'chunk' | 'draw';

@Component({
  selector: 'div.at-chart[bars]',
  standalone: true,
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (failure()) {
      <div class="at-chart__canvas">
        <div class="at-chart__failed">
          <p role="alert" style="margin: 0">{{ t('dashboard.chartFailed') }}</p>
          <button class="at-button" [variant]="'secondary'" [size]="'s'" (click)="retry()">
            {{ t('action.retry') }}
          </button>
        </div>
      </div>
    } @else {
      <div #canvas class="at-chart__canvas" role="img" [attr.aria-label]="summary()"></div>
    }
    <details class="at-chart__data">
      <summary class="at-chart__data-toggle">{{ t('dashboard.table') }}</summary>
      <ng-content />
    </details>`,
  host: {
    '[attr.aria-busy]': "busy() ? 'true' : null",
    '[style.--at-chart-rows]': 'bars().length',
  },
})
export class BarChartComponent {
  protected readonly t = t;
  /** The card title: the canvas summary starts with it (the table caption is it too). */
  readonly title = input.required<string>();
  readonly bars = input.required<Bar[]>();
  /** A refetch is under way: the previous render stays, dimmed. */
  readonly busy = input(false);
  readonly integer = input(false);
  readonly axisFormat = input<((value: number) => string) | undefined>(undefined);

  protected readonly failure = signal<Failure | null>(null);
  protected readonly summary = computed(() => chartSummary(this.title(), this.bars()));
  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');
  private readonly theme = injectThemeVersion();
  /** Redrawn only when what is drawn changes (equal data keeps the chart). */
  private readonly data = computed(() => JSON.stringify(this.bars()));

  constructor() {
    let mount = 0;
    let view: ChartView | null = null;
    const destroy = () => {
      view?.destroy();
      view = null;
    };
    inject(DestroyRef).onDestroy(() => {
      mount++;
      destroy();
    });
    effect(() => {
      const el = this.canvas()?.nativeElement;
      const data = this.data();
      const integer = this.integer();
      this.theme();
      untracked(() => {
        const run = ++mount;
        destroy();
        if (!el) return;
        loadCharts().then(
          ({ mountBars }) => {
            if (run !== mount) return;
            try {
              const format = this.axisFormat();
              view = mountBars(el, JSON.parse(data) as Bar[], {
                integer,
                ...(format ? { axisFormat: format } : {}),
              });
            } catch {
              this.failure.set('draw');
            }
          },
          () => {
            if (run === mount) this.failure.set('chunk');
          },
        );
      });
    });
  }

  protected retry(): void {
    // The chunk could not be loaded: only a new document can ask for it again (FM15 guard: once per chain).
    if (this.failure() === 'chunk') {
      reloadOnce(currentUrl());
      return;
    }
    this.failure.set(null);
  }
}
