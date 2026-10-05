import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { t } from '../app/i18n';
import { ButtonComponent, ChipComponent, injectThemeVersion, isolate, type Fullscreen } from '../app/ui';
import type { BatchGraph } from './elements';
import type { GraphView } from './cytoscape';

@Component({
  selector: 'div.at-graph[atBatchGraph]',
  standalone: true,
  imports: [ButtonComponent, ChipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (failed()) {
      <div class="at-graph__canvas">
        <p role="alert" style="margin: 0; padding: var(--sp-5)">{{ t('graph.failed') }}</p>
      </div>
    } @else {
      <div #canvas class="at-graph__canvas" role="img" [attr.aria-label]="label()"></div>
    }
    <div class="at-graph__toolbar">
      <button
        class="at-button"
        [variant]="'ghost'"
        [size]="'s'"
        [iconOnly]="true"
        [icon]="'plus'"
        [attr.aria-label]="t('graph.zoomIn')"
        (click)="zoom(1.25)"
      ></button>
      <button
        class="at-button"
        [variant]="'ghost'"
        [size]="'s'"
        [iconOnly]="true"
        [icon]="'minus'"
        [attr.aria-label]="t('graph.zoomOut')"
        (click)="zoom(0.8)"
      ></button>
      @if (fs().full()) {
        <button
          #closer
          class="at-button"
          [variant]="'ghost'"
          [size]="'s'"
          [iconOnly]="true"
          [icon]="'close'"
          [attr.aria-label]="t('graph.close')"
          (click)="fs().close()"
        ></button>
      }
    </div>
    <ul class="at-graph__legend" [attr.aria-label]="t('ui.legend')">
      @for (s of statuses(); track s) {
        <li><span class="at-chip" [status]="s"></span></li>
      }
    </ul>`,
  host: { '[attr.data-fullscreen]': "fs().full() ? '' : null" },
})
export class BatchGraphComponent {
  protected readonly t = t;
  readonly atBatchGraph = input.required<BatchGraph>();
  readonly code = input.required<string>();
  readonly fs = input.required<Fullscreen>();
  readonly labelKey = input('graph.label');

  protected readonly failed = signal(false);
  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');
  private readonly closer = viewChild('closer', { read: ElementRef });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly theme = injectThemeVersion();
  private view: GraphView | null = null;

  protected readonly statuses = computed(() => [...new Set(this.atBatchGraph().nodes.map((n) => n.status))]);
  protected readonly label = computed(() => {
    const nodes = this.atBatchGraph().nodes;
    return t(this.labelKey(), {
      code: this.code(),
      up: nodes.filter((n) => n.depth < 0).length,
      down: nodes.filter((n) => n.depth > 0).length,
    });
  });

  constructor() {
    let mount = 0;
    effect(() => {
      const el = this.canvas()?.nativeElement;
      const graph = this.atBatchGraph();
      this.theme();
      untracked(() => {
        const run = ++mount;
        this.destroyView();
        if (!el) return;
        import('./cytoscape').then(
          ({ mountGraph }) => {
            if (run !== mount || !el.isConnected) return;
            this.view = mountGraph(el, graph, (node) => {
              this.fs().close();
              if (node.accessible) void this.router.navigateByUrl(`/batches/${node.id}?tab=graph`);
              else window.location.assign(`/p/${node.publicCode}`);
            });
          },
          () => {
            if (run === mount) this.failed.set(true);
          },
        );
      });
    });
    let undo: (() => void) | null = null;
    effect(() => {
      const full = this.fs().full();
      untracked(() => {
        undo?.();
        undo = null;
        if (!full) return;
        afterNextRender(
          () => {
            if (!this.fs().full()) return;
            undo = isolate(this.host);
            (this.closer()?.nativeElement as HTMLElement | undefined)?.focus();
          },
          { injector: this.injector },
        );
      });
    });
    inject(DestroyRef).onDestroy(() => {
      mount++;
      undo?.();
      this.destroyView();
    });
  }

  private destroyView(): void {
    this.view?.destroy();
    this.view = null;
  }

  protected zoom(factor: number): void {
    this.view?.zoom(factor);
  }
}
