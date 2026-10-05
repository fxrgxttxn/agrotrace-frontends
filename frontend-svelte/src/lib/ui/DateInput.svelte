<script lang="ts" module>
  export type DateError = 'validation.date.format' | 'validation.range';
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { formatRuDate, isWithinRuDateBounds, maskRuDateInput, parseRuDate } from '@agrotrace/i18n';
  import { t } from '../app/i18n';
  import { fieldControl } from './field';

  let {
    id,
    value = $bindable(null),
    onchange,
    onvalidate,
    onblur,
    min,
    max,
    disabled = false,
    name,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedby,
  }: {
    id?: string;
    value?: string | null;
    onchange?: (iso: string | null) => void;
    onvalidate?: (error: DateError | null) => void;
    onblur?: (e: FocusEvent) => void;
    min?: string;
    max?: string;
    disabled?: boolean;
    name?: string;
    'aria-invalid'?: 'true' | 'false';
    'aria-describedby'?: string;
  } = $props();

  const control = fieldControl(() => ({ id, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedby }));
  let text = $state(formatRuDate(value));
  let textEl: HTMLInputElement | null = $state(null);
  let nativeEl: HTMLInputElement | null = $state(null);

  $effect.pre(() => {
    const model = value || null;
    const current = untrack(() => text);
    if (parseRuDate(current) !== model) text = formatRuDate(model);
  });

  function check(typed: string): DateError | null {
    if (!typed.trim()) return null;
    const iso = parseRuDate(typed);
    if (!iso) return 'validation.date.format';
    return isWithinRuDateBounds(iso, min, max) ? null : 'validation.range';
  }

  function emit(next: string) {
    text = next;
    const iso = parseRuDate(next);
    value = iso;
    onchange?.(iso);
  }

  function input(e: Event & { currentTarget: HTMLInputElement }) {
    const masked = maskRuDateInput(e.currentTarget.value);
    e.currentTarget.value = masked;
    emit(masked);
  }

  function openCalendar() {
    if (!nativeEl) return;
    nativeEl.value = parseRuDate(text) ?? '';
    try {
      nativeEl.showPicker();
    } catch {
      nativeEl.focus();
    }
  }

  function picked(e: Event & { currentTarget: HTMLInputElement }) {
    const next = formatRuDate(e.currentTarget.value);
    emit(next);
    onvalidate?.(check(next));
    textEl?.focus();
  }
</script>

<div class="at-date">
  <input
    bind:this={textEl}
    class="at-input"
    {...control()}
    {name}
    inputmode="numeric"
    placeholder="ДД.ММ.ГГГГ"
    maxlength="10"
    autocomplete="off"
    {disabled}
    value={text}
    oninput={input}
    onblur={(e) => {
      onvalidate?.(check(text));
      onblur?.(e);
    }}
  />
  <button class="at-date__button" type="button" aria-label={t('ui.openCalendar')} {disabled} onclick={openCalendar}>
    <svg aria-hidden="true"><use href="#i-calendar" /></svg>
  </button>
  <input
    bind:this={nativeEl}
    class="at-date__native"
    type="date"
    tabindex="-1"
    aria-hidden="true"
    {min}
    {max}
    {disabled}
    onchange={picked}
  />
</div>
