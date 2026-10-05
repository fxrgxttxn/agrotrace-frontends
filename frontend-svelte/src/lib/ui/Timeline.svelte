<script lang="ts" module>
  import type { Tone } from './display';

  export interface TimelineEntry {
    key: string;
    at: string;
    atText: string;
    title: string;
    meta?: string;
    tone?: Tone;
  }
</script>

<script lang="ts" generics="T extends TimelineEntry">
  import type { Snippet } from 'svelte';

  let { items, meta }: { items: T[]; meta?: Snippet<[T]> } = $props();
</script>

<ol class="at-timeline">
  {#each items as it, i (it.key)}
    <li class="at-timeline__item" data-tone={it.tone} data-current={i === items.length - 1 ? '' : undefined}>
      <time class="at-timeline__time" datetime={it.at}>{it.atText}</time><p class="at-timeline__title">{it.title}</p
      >{#if meta}<p class="at-timeline__meta">{@render meta(it)}</p>{:else if it.meta !== undefined}<p
          class="at-timeline__meta">{it.meta}</p
        >{/if}
    </li>
  {/each}
</ol>
