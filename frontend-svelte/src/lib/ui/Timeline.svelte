<script lang="ts" module>
  import type { Tone } from './display';

  export interface TimelineEntry {
    key: string;
    /** ISO instant for `datetime`. */
    at: string;
    /** Display text of the instant (ДД.ММ.ГГГГ, ЧЧ:ММ). */
    atText: string;
    title: string;
    /** Plain text meta (richer content: the `meta` snippet, with the item). */
    meta?: string;
    tone?: Tone;
  }
</script>

<script lang="ts" generics="T extends TimelineEntry">
  import type { Snippet } from 'svelte';

  /** `at-timeline` (README «История»): the last entry is `data-current`. `meta` — richer content than `item.meta`
   * (e.g. an avatar and a name), given the item. */
  let { items, meta }: { items: T[]; meta?: Snippet<[T]> } = $props();
</script>

<ol class="at-timeline">
  {#each items as it, i (it.key)}
    <li class="at-timeline__item" data-tone={it.tone} data-current={i === items.length - 1 ? '' : undefined}>
      <time class="at-timeline__time" datetime={it.at}>{it.atText}</time>
      <p class="at-timeline__title">{it.title}</p>
      {#if meta}
        <p class="at-timeline__meta">{@render meta(it)}</p>
      {:else if it.meta !== undefined}
        <p class="at-timeline__meta">{it.meta}</p>
      {/if}
    </li>
  {/each}
</ol>
