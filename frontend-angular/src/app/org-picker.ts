import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { Organization, OrganizationDirectoryPage, OrganizationType } from '@agrotrace/api-client';
import { enumLabel } from '@agrotrace/i18n';
import { call } from './api';
import { t } from './i18n';
import { injectQuery } from './query';
import { SessionService } from './session';
import { ComboboxComponent, FieldContext, type ComboOption } from './ui';

const CHOSEN_FRESH_MS = 5 * 60 * 1000;

@Component({
  selector: 'div.at-field[orgPicker]',
  standalone: true,
  imports: [ComboboxComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FieldContext, useExisting: OrgPickerComponent }],
  template: `<label class="at-field__label" [attr.for]="orgPicker()">{{ label() }}</label>
    <div
      class="at-combobox"
      [listLabel]="label()"
      [query]="query()"
      [options]="options()"
      [loading]="searching()"
      [selected]="value() || null"
      (queryChange)="typed($event)"
      (search)="search.set($event)"
      (chosen)="pick($event)"
    ></div>
    @if (error()) {
      <p class="at-field__error" [attr.id]="errorId()" role="alert">{{ error() }}</p>
    }`,
  host: { '[attr.data-invalid]': "error() ? '' : null" },
})
export class OrgPickerComponent extends FieldContext {
  readonly orgPicker = input.required<string>();
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly types = input<OrganizationType[] | undefined>(undefined);
  readonly error = input<string | null | undefined>(null);
  readonly exclude = input<string | undefined>(undefined);
  readonly valueChange = output<string | null>();
  readonly org = output<{ id: string; name: string; type: OrganizationType } | null>();

  readonly controlId = computed(() => this.orgPicker());
  readonly errorId = computed(() => (this.error() ? `${this.orgPicker()}-error` : null));
  readonly invalid = computed(() => Boolean(this.error()));

  private readonly session = inject(SessionService);
  protected readonly query = signal('');
  protected readonly search = signal<string | null>(null);

  private readonly picked = signal<string | null>(null);
  private readonly chosen = injectQuery(
    () => {
      const id = this.value();
      if (id !== '' && this.picked() === id) return null;
      return {
        key: `organization:${id}`,
        load: () =>
          id
            ? call<Organization>(this.session.api.GET('/organizations/{id}', { params: { path: { id } } }))
            : Promise.resolve(null),
      };
    },
    { freshMs: CHOSEN_FRESH_MS },
  );
  private readonly found = injectQuery(() => {
    const text = this.search()?.trim() ?? '';
    const types = this.types();
    return {
      key: `organizations:directory:${JSON.stringify([text, types ?? null])}`,
      load: () =>
        text
          ? call<OrganizationDirectoryPage>(
              this.session.api.GET('/organizations', {
                params: { query: { q: text, size: 20, sort: 'name,asc', ...(types ? { type: types } : {}) } },
              }),
            )
          : Promise.resolve(null),
    };
  });
  protected readonly searching = computed(() => Boolean(this.search()?.trim()) && this.found.fetching());
  protected readonly options = computed<ComboOption[]>(() =>
    this.search()?.trim()
      ? (this.found.data()?.items ?? [])
          .filter((o) => o.id !== this.exclude())
          .map((o) => ({ value: o.id, label: o.name, meta: enumLabel(t, 'OrganizationType', o.type) }))
      : [],
  );

  constructor() {
    super();
    effect(
      () => {
        const value = this.value();
        const org = this.chosen.data();
        untracked(() => {
          if (value === '') this.query.set('');
          else if (org && org.id === value) {
            this.query.set(org.name);
            this.org.emit(org);
          }
        });
      },
      { allowSignalWrites: true },
    );
  }

  protected typed(text: string): void {
    this.query.set(text);
    if (text.trim() === '' && this.value() !== '') {
      this.valueChange.emit(null);
      this.org.emit(null);
    }
  }

  protected pick(o: ComboOption): void {
    this.picked.set(o.value);
    this.query.set(o.label);
    this.valueChange.emit(o.value);
    const org = this.found.data()?.items.find((x) => x.id === o.value);
    if (org) this.org.emit(org);
  }
}
