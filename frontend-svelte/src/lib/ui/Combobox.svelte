<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '../app/i18n';
  import { highlight, SEARCH_DELAY_MS, type ComboOption } from './combobox';
  import { fieldControl } from './field';

  let {
    id,
    listLabel,
    query = $bindable(''),
    onquery,
    onsearch,
    options,
    loading = false,
    selected = null,
    onselect,
    disabled = false,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedby,
  }: {
    id?: string;
    listLabel: string;
    query?: string;
    onquery?: (text: string) => void;
    onsearch?: (text: string) => void;
    options: ComboOption[];
    loading?: boolean;
    selected?: string | null;
    onselect: (option: ComboOption) => void;
    disabled?: boolean;
    'aria-invalid'?: 'true' | 'false';
    'aria-describedby'?: string;
  } = $props();

  const control = fieldControl(() => ({ id, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedby }));
  const inputId = $derived(control().id ?? 'combobox');
  const listId = $derived(`${inputId}-list`);
  let open = $state(false);
  let active = $state(-1);
  let timer: ReturnType<typeof setTimeout> | null = null;

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  const enabled = $derived(options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled));
  const activeIndex = $derived(open && active >= 0 && active < options.length ? active : -1);
  const showStatus = $derived(loading || options.length === 0);
  const optId = (i: number) => `${inputId}-opt-${i + 1}`;

  function move(to: number) {
    if (enabled.length === 0) return;
    const pos = Math.max(0, Math.min(enabled.length - 1, to));
    active = enabled[pos]!.i;
  }
  const posOf = (index: number) => enabled.findIndex(({ i }) => i === index);

  function choose(o: ComboOption) {
    onselect(o);
    open = false;
    active = -1;
  }

  function keydown(e: KeyboardEvent) {
    const handled = (() => {
      switch (e.key) {
        case 'ArrowDown':
          if (!open) open = true;
          else move(activeIndex < 0 ? 0 : posOf(activeIndex) + 1);
          return true;
        case 'ArrowUp':
          if (!open) return false;
          move(activeIndex < 0 ? enabled.length - 1 : posOf(activeIndex) - 1);
          return true;
        case 'Home':
          if (!open) return false;
          move(0);
          return true;
        case 'End':
          if (!open) return false;
          move(enabled.length - 1);
          return true;
        case 'Enter': {
          if (!open) return false;
          const o = activeIndex >= 0 ? options[activeIndex] : undefined;
          if (o && !o.disabled) choose(o);
          return true;
        }
        case 'Escape':
          if (!open) return false;
          open = false;
          active = -1;
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  }

  function input(e: Event & { currentTarget: HTMLInputElement }) {
    const text = e.currentTarget.value;
    query = text;
    onquery?.(text);
    open = true;
    active = -1;
    if (onsearch) {
      if (timer) clearTimeout(timer);
      const search = onsearch;
      timer = setTimeout(() => search(text), SEARCH_DELAY_MS);
    }
  }
</script>

<div class="at-combobox">
  <input
    class="at-input"
    {...control()}
    id={inputId}
    role="combobox"
    aria-autocomplete="list"
    autocomplete="off"
    aria-expanded={open ? 'true' : 'false'}
    aria-controls={listId}
    aria-activedescendant={activeIndex >= 0 && !showStatus ? optId(activeIndex) : undefined}
    aria-busy={loading ? 'true' : undefined}
    {disabled}
    value={query}
    oninput={input}
    onkeydown={keydown}
    onblur={() => {
      open = false;
      active = -1;
    }}
  />
  {#if showStatus}
    <div class="at-combobox__list" id={listId} role="status">{#if open && loading}<p class="at-combobox__status">
          <span class="at-spinner" aria-hidden="true"></span>{t('ui.searching')}
        </p>{:else if open && query.trim()}<p class="at-combobox__status">{t('empty.search')}</p>{/if}</div>
  {:else}
    <ul
      class="at-combobox__list"
      role="listbox"
      id={listId}
      aria-label={listLabel}
      hidden={!open}
      onmousedown={(e) => e.preventDefault()}
    >
      {#each options as o, i (o.value)}
        {@const parts = highlight(o.label, query)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          role="option"
          id={optId(i)}
          aria-selected={o.value === selected ? 'true' : 'false'}
          aria-disabled={o.disabled ? 'true' : undefined}
          data-active={i === activeIndex ? '' : undefined}
          onclick={() => {
            if (!o.disabled) choose(o);
          }}
        >
          <span
            >{#if parts}{parts[0]}<mark>{parts[1]}</mark>{parts[2]}{:else}{o.label}{/if}</span
          >{#if o.meta}<span class="at-combobox__meta">{o.meta}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
