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
  readonly title = input.required<string>();
  readonly bars = input.required<Bar[]>();
  readonly busy = input(false);
  readonly integer = input(false);
  readonly axisFormat = input<((value: number) => string) | undefined>(undefined);

  protected readonly failure = signal<Failure | null>(null);
  protected readonly summary = computed(() => chartSummary(this.title(), this.bars()));
  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');
  private readonly theme = injectThemeVersion();
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
    if (this.failure() === 'chunk') {
      reloadOnce(currentUrl());
      return;
    }
    this.failure.set(null);
  }
}
