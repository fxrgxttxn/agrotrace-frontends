<script lang="ts" module>
  export const SEARCH_INPUT_DELAY_MS = 300;

  export interface ToolbarSearch {
    label: string;
    placeholder: string;
    value: string;
    onchange: (text: string) => void;
  }
</script>

<script lang="ts">
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import { t } from '../app/i18n';
  import { wideScreen } from './wide.svelte';

  let {
    search,
    filters,
    count = 0,
    note,
  }: {
    search?: ToolbarSearch;
    filters?: Snippet;
    count?: number;
    note?: Snippet;
  } = $props();

  const screen = wideScreen();
  let opened = $state(false);
  const open = $derived(screen.wide || opened);
  let text = $state(untrack(() => search?.value ?? ''));
  let sent = untrack(() => search?.value ?? '');
  let timer: ReturnType<typeof setTimeout> | null = null;
  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  $effect.pre(() => {
    const external = search?.value ?? '';
    if (external !== sent) {
      sent = external;
      text = external;
    }
  });

  function type(value: string) {
    text = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      sent = value;
      search?.onchange(value);
    }, SEARCH_INPUT_DELAY_MS);
  }
</script>

<div class="at-page__toolbar">
  {#if search}
    <div class="at-page__search">
      <svg aria-hidden="true"><use href="#i-search" /></svg>
      <input
        class="at-input"
        type="search"
        placeholder={search.placeholder}
        aria-label={search.label}
        value={text}
        oninput={(e) => type(e.currentTarget.value)}
      />
    </div>
  {/if}
  {#if filters}
    <details
      class="at-page__filters"
      {open}
      ontoggle={(e) => {
        if (!screen.wide) opened = e.currentTarget.open;
      }}
    >
      <summary class="at-page__filters-toggle"
        >{t('filters.toggle')}{#if count > 0}<span class="at-visually-hidden">{t('filters.selected')}</span>
          <span class="at-page__filters-count">{count}</span>{/if}</summary
      >
      <div class="at-page__filters-body">{@render filters()}</div>
    </details>
  {/if}
  {#if note}<p class="at-page__note">{@render note()}</p>{/if}
</div>
