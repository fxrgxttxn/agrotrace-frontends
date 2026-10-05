import {
  ChangeDetectionStrategy,
  Component,
  contentChildren,
  Directive,
  ElementRef,
  inject,
  input,
  output,
  TemplateRef,
  viewChild,
  ViewContainerRef,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

@Directive({ selector: 'ng-template[atTabPanel]', standalone: true })
export class TabPanelDirective {
  readonly id = input.required<string>({ alias: 'atTabPanel' });
  readonly template = inject(TemplateRef);
}

@Component({
  selector: 'div.at-tabs[tabs]',
  standalone: true,
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (tab of tabs(); track tab.id) {
      <button
        class="at-tabs__tab"
        role="tab"
        [attr.id]="'tab-' + tab.id"
        [attr.aria-selected]="tab.id === selected() ? 'true' : 'false'"
        [attr.aria-controls]="'panel-' + tab.id"
        [attr.tabindex]="tab.id === selected() ? 0 : -1"
        type="button"
        (click)="select.emit(tab.id)"
      >
        {{ tab.label }}
        @if (tab.count !== undefined) {
          <span class="at-tabs__count">{{ tab.count }}</span>
        }
      </button>
    }
    <ng-template #panels>
      @for (tab of tabs(); track tab.id) {
        <div
          class="at-tabs__panel"
          role="tabpanel"
          [attr.id]="'panel-' + tab.id"
          [attr.aria-labelledby]="'tab-' + tab.id"
          tabindex="0"
          [hidden]="tab.id !== selected()"
        >
          @if (tab.id === selected()) {
            @if (panelFor(tab.id); as p) {
              <ng-container *ngTemplateOutlet="p.template" />
            }
          }
        </div>
      }
    </ng-template>`,
  host: { role: 'tablist', '[attr.aria-label]': 'label()', '(keydown)': 'onKeyDown($event)' },
})
export class TabsComponent implements OnInit, OnDestroy {
  readonly label = input.required<string>();
  readonly tabs = input.required<TabDef[]>();
  readonly selected = input.required<string>();
  readonly select = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly vcr = inject(ViewContainerRef);
  private readonly panelsTpl = viewChild.required<TemplateRef<unknown>>('panels');
  private readonly panels = contentChildren(TabPanelDirective);

  ngOnInit(): void {
    this.vcr.createEmbeddedView(this.panelsTpl());
  }

  ngOnDestroy(): void {
    this.vcr.clear();
  }

  protected panelFor(id: string): TabPanelDirective | undefined {
    return this.panels().find((p) => p.id() === id);
  }

  protected onKeyDown(e: KeyboardEvent): void {
    const tabs = this.tabs();
    const i = tabs.findIndex((tab) => tab.id === this.selected());
    const next = (
      { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 } as Record<string, number>
    )[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length]!;
    this.select.emit(target.id);
    this.host.querySelector<HTMLElement>(`#tab-${CSS.escape(target.id)}`)?.focus();
  }
}
