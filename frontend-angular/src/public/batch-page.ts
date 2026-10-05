import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  type OnInit,
  Injector,
  inject,
  runInInjectionContext,
  signal,
  type Signal,
} from '@angular/core';
import { withVariant, type PublicBatch, type SafetyStatus } from '@agrotrace/api-client/public';
import { formatLocalDate, photoCredit } from '@agrotrace/i18n/public';
import { ArtDirective } from './art';
import { injectBatch, type BatchState } from './data';
import { LOCALE, t } from './i18n';
import { complaintPath, onLink } from './nav';
import { ART, arrivalFocus, FailedComponent, HEADER, LOADING, NOT_FOUND, titleEffect } from './views';

const SAFETY_ICON: Record<SafetyStatus, string> = {
  SAFE: 'check',
  RECALLED: 'alert',
  BLOCKED: 'alert',
  UNKNOWN: 'clock',
};

const date = (iso: string) => formatLocalDate(iso, LOCALE);

function initials(fullName: string): string {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join('').toLocaleUpperCase('ru');
  return ([...parts[0]!][0]! + [...parts[1]!][0]!).toLocaleUpperCase('ru');
}

function avatar(name: string, url: string, size: string): string {
  return `@if (${url}) {
              <span class="at-avatar" data-size="${size}" data-shape="square"><img [attr.src]="variant(${url}, 96)" alt="" /></span>
            } @else {
              <span class="at-avatar" data-size="${size}" data-shape="square" aria-hidden="true">{{ initials(${name}) }}</span>
            }`;
}

@Component({
  selector: 'main[batchPage]',
  standalone: true,
  imports: [ArtDirective, FailedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'at-page at-public', id: 'main', tabindex: '-1' },
  template: `${HEADER}
    <div class="at-public__stack">
      @switch (state().status) {
        @case ('loading') {
          ${LOADING}
        }
        @case ('notFound') {
          ${NOT_FOUND}
        }
        @case ('failed') {
          <article
            class="at-card"
            data-furrow=""
            [atFailed]="failure()!"
            [busy]="failedBusy()"
            (retried)="retry()"
          ></article>
        }
        @case ('ok') {
          @if (batch(); as b) {
            <article class="at-card" data-furrow="">
              <div class="at-card__body">
                @if (b.safety === 'RECALLED') {
                  <div class="at-public__warning">
                    <svg class="at-empty__art" aria-hidden="true" [atArt]="art.recallWarning"></svg>
                    <h2 class="at-public__warning-title">{{ t('public.recallTitle') }}</h2>
                    <p class="at-public__warning-text">{{ t('public.safetyNote.RECALLED') }}</p>
                  </div>
                }
                <div class="at-public__hero">
                  @if (b.product.imageUrl) {
                    <figure class="at-public__photo">
                      <img
                        [attr.src]="variant(b.product.imageUrl, 480)"
                        alt=""
                        width="480"
                        height="360"
                        fetchpriority="high"
                      />
                      @if (credit(); as c) {
                        <!-- prettier-ignore -->
                        <figcaption>@for (part of captionParts; track $index) {@if ($index % 2 === 0) {{{ part }}} @else {<a [attr.href]="part === 'author' ? c.source : c.licenseUrl" rel="noopener noreferrer" target="_blank">{{ part === 'author' ? c.author : c.license }}</a>}}</figcaption>
                      }
                    </figure>
                  }
                  <div class="at-public__summary">
                    <!-- prettier-ignore -->
                    <p class="at-public__status" [attr.data-safety]="b.safety"><svg class="at-public__status-icon" aria-hidden="true"><use [attr.href]="'#i-' + icon[b.safety]"></use></svg>{{ t('status.safety.' + b.safety) }}</p>
                    @if (b.safety === 'BLOCKED' || b.safety === 'UNKNOWN') {
                      <p class="at-public__note">{{ t('public.safetyNote.' + b.safety) }}</p>
                    }
                    <dl class="at-card__facts">
                      <div>
                        <dt>{{ t('public.code') }}</dt>
                        <dd>
                          <span class="at-mono">{{ b.publicCode }}</span>
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </div>
            </article>
            <article class="at-card">
              <header class="at-card__header">
                <h2 class="at-card__title">{{ t('public.origin') }}</h2>
              </header>
              <div class="at-card__body">
                <!-- prettier-ignore -->
                <p class="at-public__org">${avatar('b.origin.farmName', 'b.origin.logoUrl', 'l')}<span><span class="at-public__org-type">{{ t(b.producedAt ? 'public.producer' : 'public.farm') }}</span>{{ b.origin.farmName }}</span></p>
                <dl class="at-card__facts">
                  <div>
                    <dt>{{ t('public.region') }}</dt>
                    <dd>{{ b.origin.region.name }}</dd>
                  </div>
                  @if (b.harvestedAt) {
                    <div>
                      <dt>{{ t('public.harvestedAt') }}</dt>
                      <dd>{{ date(b.harvestedAt) }}</dd>
                    </div>
                  }
                  @if (b.producedAt) {
                    <div>
                      <dt>{{ t('public.producedAt') }}</dt>
                      <dd>{{ date(b.producedAt) }}</dd>
                    </div>
                  }
                </dl>
              </div>
            </article>
            <article class="at-card">
              <header class="at-card__header">
                <h2 class="at-card__title">{{ t('public.path') }}</h2>
              </header>
              <div class="at-card__body">
                <ol class="at-timeline">
                  @for (s of b.path; track $index; let last = $last) {
                    <li class="at-timeline__item" [attr.data-current]="last ? '' : null">
                      <time class="at-timeline__time" [attr.datetime]="s.from">{{
                        s.to
                          ? t('public.period', { from: date(s.from), to: date(s.to) })
                          : t('public.since', { date: date(s.from) })
                      }}</time>
                      <p class="at-timeline__title">{{ s.orgName }}</p>
                      <!-- prettier-ignore -->
                      <p class="at-timeline__meta">${avatar('s.orgName', 's.logoUrl', 's')}{{ t('orgType.' + s.orgType) }}</p>
                    </li>
                  }
                </ol>
              </div>
            </article>
            <article class="at-card">
              <header class="at-card__header">
                <h2 class="at-card__title">{{ t('public.lab') }}</h2>
              </header>
              <div class="at-card__body">
                @if (b.labSummary.total === 0) {
                  <p class="at-public__note">{{ t('public.labNone') }}</p>
                } @else {
                  <dl class="at-card__facts">
                    <div>
                      <dt>{{ t('public.labTotal') }}</dt>
                      <dd>{{ b.labSummary.total }}</dd>
                    </div>
                    <div>
                      <dt>{{ t('public.labPassed') }}</dt>
                      <dd>{{ b.labSummary.passed }}</dd>
                    </div>
                    @if (b.labSummary.lastDate && b.labSummary.lastConclusion) {
                      <div>
                        <dt>{{ t('public.labLast') }}</dt>
                        <!-- prettier-ignore -->
                        <dd><span class="at-public__lab-last">{{ date(b.labSummary.lastDate) }}<span class="at-chip" [attr.data-tone]="b.labSummary.lastConclusion === 'PASS' ? 'ok' : 'danger'">{{ t('labConclusion.' + b.labSummary.lastConclusion) }}</span></span></dd>
                      </div>
                    }
                  </dl>
                }
              </div>
            </article>
            <div class="at-public__actions">
              <a
                class="at-button"
                data-variant="primary"
                [attr.href]="complaintPath(b.publicCode)"
                (click)="onLink($event)"
                >{{ t('public.report') }}</a
              >
            </div>
          }
        }
      }
    </div>`,
})
export class BatchPageComponent implements OnInit {
  protected readonly t = t;
  protected readonly art = ART;
  protected readonly icon = SAFETY_ICON;
  protected readonly date = date;
  protected readonly initials = initials;
  protected readonly variant = withVariant;
  protected readonly complaintPath = complaintPath;
  protected readonly onLink = onLink;
  protected readonly captionParts = t('public.photo').split(/\{(\w+)\}/);
  readonly batchPage = input.required<string>();
  private readonly injector = inject(Injector);
  private readonly loaded = signal<{ state: Signal<BatchState>; retry: () => void } | null>(null);
  protected readonly state = computed<BatchState>(() => this.loaded()?.state() ?? { status: 'loading' });
  protected readonly batch = computed<PublicBatch | null>(() => {
    const s = this.state();
    return s.status === 'ok' ? s.batch : null;
  });
  protected readonly failure = computed(() => {
    const s = this.state();
    return s.status === 'failed' ? s.failure : null;
  });
  protected readonly failedBusy = computed(() => {
    const s = this.state();
    return s.status === 'failed' && s.busy;
  });
  protected readonly credit = computed(() => photoCredit(this.batch()?.product.imageUrl));
  protected readonly title = computed(() => this.batch()?.product.name ?? t('page.publicBatch'));

  constructor() {
    titleEffect(this.title);
    arrivalFocus();
  }

  ngOnInit(): void {
    runInInjectionContext(this.injector, () => this.loaded.set(injectBatch(this.batchPage())));
  }

  protected retry(): void {
    this.loaded()?.retry();
  }
}
