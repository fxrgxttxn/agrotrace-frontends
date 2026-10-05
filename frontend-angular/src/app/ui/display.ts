import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  input,
  TemplateRef,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { t } from '../i18n';

export type Tone = 'neutral' | 'attention' | 'ok' | 'move' | 'danger' | 'danger-solid';

@Component({
  selector: 'span.at-spinner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
  host: { 'aria-hidden': 'true' },
})
export class SpinnerComponent {}

@Component({
  selector: 'span.at-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (status()) {
      <ng-container>{{ t('status.batch.' + status()) }}</ng-container>
    }
    <ng-content />`,
  host: {
    '[attr.data-status]': 'status() ?? null',
    '[attr.data-tone]': 'tone() ?? null',
    '[attr.data-size]': 'size() ?? null',
  },
})
export class ChipComponent {
  protected readonly t = t;
  readonly status = input<string | undefined>(undefined);
  readonly tone = input<Tone | undefined>(undefined);
  readonly size = input<'l' | undefined>(undefined);
}

@Component({
  selector: 'span.at-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
  host: { '[attr.data-shape]': 'shape()', '[style.width]': 'width() ?? null' },
})
export class SkeletonComponent {
  readonly shape = input<'text' | 'block' | 'circle'>('text');
  readonly width = input<string | undefined>(undefined);
}

export function initials(fullName: string): string {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join('').toLocaleUpperCase('ru');
  return ([...parts[0]!][0]! + [...parts[1]!][0]!).toLocaleUpperCase('ru');
}

@Component({
  selector: 'span.at-avatar[name]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (src()) {
      <img [attr.src]="src()" [attr.alt]="decorative() || hidden() ? '' : name()" />
    } @else {
      <ng-container>{{ letters() }}</ng-container>
    }`,
  host: {
    '[attr.data-size]': 'size()',
    '[attr.data-shape]': 'shape() ?? null',
    '[attr.role]': "src() || silent() ? null : 'img'",
    '[attr.aria-label]': 'src() || silent() ? null : name()',
    '[attr.aria-hidden]': "src() ? (hidden() ? 'true' : null) : silent() ? 'true' : null",
  },
})
export class AvatarComponent {
  readonly name = input.required<string>();
  readonly src = input<string | null | undefined>(null);
  readonly size = input<'s' | 'm' | 'l'>('m');
  readonly shape = input<'square' | undefined>(undefined);
  readonly decorative = input(false);
  readonly hidden = input(false);
  protected readonly silent = computed(() => this.decorative() || this.hidden());
  protected readonly letters = computed(() => initials(this.name()));
}

export function sparkPoints(values: number[]): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = 2 + (i * 92) / (values.length - 1);
      const y = 30 - ((v - min) * 28) / span;
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}

@Component({
  selector: 'div.at-metric',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="at-metric__label">{{ label() }}</p>
    <!-- prettier-ignore -->
    <p class="at-metric__value">{{ value() }}@if (unit() !== undefined) {<span class="at-metric__unit">{{ unit() }}</span>}@if (delta() !== undefined) {<span class="at-metric__delta">{{ delta() }}</span>}</p>
    @if (spark(); as s) {
      @if (s.length > 1) {
        <div class="at-metric__spark" aria-hidden="true">
          <svg viewBox="0 0 96 32">
            <polyline
              [attr.points]="points()"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
      }
    }`,
  host: { '[attr.data-tone]': 'tone() ?? null' },
})
export class MetricComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly unit = input<string | undefined>(undefined);
  readonly tone = input<'danger' | undefined>(undefined);
  readonly spark = input<number[] | undefined>(undefined);
  readonly delta = input<string | undefined>(undefined);
  protected readonly points = computed(() => sparkPoints(this.spark() ?? []));
}

@Component({
  selector: 'div.at-progress[progressId]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span
      class="at-progress__label"
      [class.at-visually-hidden]="labelHidden()"
      [attr.id]="progressId()"
      >{{ label() }}</span
    >
    <span class="at-progress__value">{{ t('ui.progressValue', { value: value(), max: max() }) }}</span>
    <progress
      class="at-progress__bar"
      [attr.max]="max()"
      [attr.value]="value()"
      [attr.aria-labelledby]="progressId()"
    ></progress>`,
  host: { '[attr.data-tone]': 'tone() ?? null' },
})
export class ProgressComponent {
  protected readonly t = t;
  readonly progressId = input.required<string>();
  readonly label = input.required<string>();
  readonly value = input.required<number>();
  readonly max = input.required<number>();
  readonly tone = input<'danger' | undefined>(undefined);
  readonly labelHidden = input(false);
}

@Component({
  selector: 'ol.at-stepper',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (s of steps(); track s; let i = $index) {
    <li
      class="at-stepper__step"
      [attr.data-done]="i < current() ? '' : null"
      [attr.aria-current]="i === current() ? 'step' : null"
    >
      <span class="at-stepper__marker">{{ i + 1 }}</span
      ><span class="at-stepper__label">{{ s }}</span>
    </li>
  }`,
  host: { '[attr.aria-label]': 'label()' },
})
export class StepperComponent {
  readonly label = input.required<string>();
  readonly steps = input.required<string[]>();
  readonly current = input.required<number>();
}

export interface TimelineEntry {
  key: string;
  at: string;
  atText: string;
  title: string;
  meta?: string;
  tone?: Tone;
}

@Component({
  selector: 'ol.at-timeline',
  standalone: true,
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (it of items(); track it.key; let last = $last) {
    <li class="at-timeline__item" [attr.data-tone]="it.tone ?? null" [attr.data-current]="last ? '' : null">
      <time class="at-timeline__time" [attr.datetime]="it.at">{{ it.atText }}</time>
      <p class="at-timeline__title">{{ it.title }}</p>
      @if (metaTemplate(); as tpl) {
        <p class="at-timeline__meta"><ng-container *ngTemplateOutlet="tpl; context: { $implicit: it }" /></p>
      } @else if (it.meta !== undefined) {
        <p class="at-timeline__meta">{{ it.meta }}</p>
      }
    </li>
  }`,
})
export class TimelineComponent {
  readonly items = input.required<TimelineEntry[]>();
  protected readonly metaTemplate = contentChild<TemplateRef<{ $implicit: TimelineEntry }>>('meta');
}

@Component({
  selector: 'article.at-card:not([atDecision])',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content />`,
  host: { '[attr.data-furrow]': "furrow() ? '' : null" },
})
export class CardComponent {
  readonly furrow = input(false);
}

@Component({
  selector: 'header.at-card__header[cardTitle]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@switch (level()) {
      @case (1) {
        <h1 class="at-card__title" [attr.id]="titleId() ?? null">{{ cardTitle() }}</h1>
      }
      @case (3) {
        <h3 class="at-card__title" [attr.id]="titleId() ?? null">{{ cardTitle() }}</h3>
      }
      @default {
        <h2 class="at-card__title" [attr.id]="titleId() ?? null">{{ cardTitle() }}</h2>
      }
    }
    <ng-content />`,
})
export class CardHeaderComponent {
  readonly cardTitle = input.required<string>();
  readonly level = input<1 | 2 | 3>(2);
  readonly titleId = input<string | undefined>(undefined);
}

export interface CardFact {
  term: string;
  value: string;
  key?: string;
}

@Component({
  selector: 'dl.at-card__facts[facts]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (f of facts(); track $index) {
    <div>
      <dt>{{ f.term }}</dt>
      <dd>{{ f.value }}</dd>
    </div>
  }`,
})
export class CardFactsComponent {
  readonly facts = input.required<CardFact[]>();
}
