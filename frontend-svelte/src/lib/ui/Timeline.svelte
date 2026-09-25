<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { Tone } from './display';

  export interface TimelineEntry {
    key: string;
    /** ISO instant for `datetime`. */
    at: string;
    /** Display text of the instant (ДД.ММ.ГГГГ, ЧЧ:ММ). */
    atText: string;
    title: string;
    /** Text, or markup (an avatar and a name). */
    meta?: string | Snippet;
    tone?: Tone;
  }
</script>

<script lang="ts">
  /** `at-timeline` (README «История»): the last entry is `data-current`. */
  let { items }: { items: TimelineEntry[] } = $props();
</script>

<ol class="at-timeline">
  {#each items as it, i (it.key)}
    <li class="at-timeline__item" data-tone={it.tone} data-current={i === items.length - 1 ? '' : undefined}>
      <time class="at-timeline__time" datetime={it.at}>{it.atText}</time>
      <p class="at-timeline__title">{it.title}</p>
      {#if it.meta !== undefined}
        <p class="at-timeline__meta">{#if typeof it.meta === 'string'}{it.meta}{:else}{@render it.meta()}{/if}</p>
      {/if}
    </li>
  {/each}
</ol>
