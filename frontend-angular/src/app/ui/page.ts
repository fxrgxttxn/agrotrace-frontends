import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  viewChild,
  type AfterViewInit,
  type OnDestroy,
} from '@angular/core';
import { t } from '../i18n';
import { RouteFocusService } from '../route-focus';
import { IllustrationComponent, type IllustrationName } from './illustrations.generated';
import { SkeletonComponent } from './display';

/** `at-page__header` (README «Страница»): the title is a noun, no subtitle, `tabindex="-1"` — the focus target after a
 * route change (README «Фокус при смене маршрута»). Sets the document title. Actions are projected as
 * `<div class="at-page__actions">`. The page itself is the routed component's host (`div.at-page` in the shell,
 * `main.at-page` outside it). */
@Component({
  selector: 'div.at-page__header[pageTitle]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h1 #title class="at-page__title" tabindex="-1">{{ pageTitle() }}</h1>
    <ng-content />`,
})
export class PageHeaderComponent implements AfterViewInit, OnDestroy {
  readonly pageTitle = input.required<string>();
  private readonly focus = inject(RouteFocusService, { optional: true });
  private readonly title = viewChild.required<ElementRef<HTMLElement>>('title');

  constructor() {
    effect(() => {
      document.title = `${this.pageTitle()} — AgroTrace`;
    });
  }

  ngAfterViewInit(): void {
    this.focus?.register(this.title().nativeElement);
  }

  ngOnDestroy(): void {
    this.focus?.unregister(this.title().nativeElement);
  }
}

/** Loading placeholder of a page area (`aria-busy`). */
@Component({
  selector: 'div.at-page[loading]',
  standalone: true,
  imports: [SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="at-visually-hidden">{{ t('shell.loading') }}</span>
    <div class="at-page__header"><span class="at-skeleton" [width]="'12rem'"></span></div>
    <span class="at-skeleton" [shape]="'block'"></span>`,
  host: { 'aria-busy': 'true' },
})
export class PageLoadingComponent {
  protected readonly t = t;
  readonly loading = input(true);
}

/** `at-empty` (README «Пустое состояние»): illustration, one line, one action (projected). */
@Component({
  selector: 'div.at-empty[art]',
  standalone: true,
  imports: [IllustrationComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg class="at-empty__art" [art]="art()"></svg>
    <p class="at-empty__text">{{ text() }}</p>
    <ng-content />`,
})
export class EmptyComponent {
  readonly art = input.required<IllustrationName>();
  readonly text = input.required<string>();
}
