<script lang="ts" module>
  export function pageWindow(page: number, pages: number): (number | null)[] {
    const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
    const out: (number | null)[] = [];
    let prev = 0;
    for (const p of [...keep].sort((a, b) => a - b)) {
      if (p - prev > 1) out.push(p - prev === 2 ? p - 1 : null);
      out.push(p);
      prev = p;
    }
    return out;
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { t } from '../app/i18n';
  import { withBase } from '../app/paths';

  let {
    page,
    size,
    total,
    label,
    hrefFor,
    onpage,
  }: {
    page: number;
    size: number;
    total: number;
    label?: string;
    hrefFor?: (page: number) => string;
    onpage?: (page: number) => void;
  } = $props();

  const pages = $derived(Math.max(1, Math.ceil(total / size)));
  const from = $derived(total === 0 ? 0 : (page - 1) * size + 1);
  const to = $derived(Math.min(total, page * size));
  let nav: HTMLElement | null = $state(null);

  async function go(p: number) {
    if (p === page || !onpage) return;
    onpage(p);
    await tick();
    const active = document.activeElement;
    if (active === null || active === document.body || (active as HTMLButtonElement).disabled)
      nav?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }
</script>

{#snippet arrow(dir: 'left' | 'right')}<svg aria-hidden="true"><use href="#i-chevron-{dir}" /></svg>{/snippet}

{#snippet item(p: number, content: Snippet, aria: { label?: string; current?: boolean })}
  {#if onpage}
    <button
      class="at-pagination__item"
      type="button"
      aria-label={aria.label}
      aria-current={aria.current ? 'page' : undefined}
      onclick={() => void go(p)}>{@render content()}</button
    >
  {:else}
    <a
      class="at-pagination__item"
      href={hrefFor && withBase(hrefFor(p))}
      aria-label={aria.label}
      aria-current={aria.current ? 'page' : undefined}>{@render content()}</a
    >
  {/if}
{/snippet}

{#snippet none(content: Snippet, name: string)}
  <button class="at-pagination__item" type="button" aria-label={name} disabled>{@render content()}</button>
{/snippet}

{#snippet left()}{@render arrow('left')}{/snippet}
{#snippet right()}{@render arrow('right')}{/snippet}

<nav class="at-pagination" aria-label={label ?? t('ui.pages')} bind:this={nav}>
  <p class="at-pagination__summary">{t('ui.pageSummary', { from, to, total })}</p>
  <ul class="at-pagination__pages">
    <li>
      {#if page > 1}
        {@render item(page - 1, left, { label: t('ui.prevPage') })}
      {:else}
        {@render none(left, t('ui.prevPage'))}
      {/if}
    </li>
    {#each pageWindow(page, pages) as p, i (p ?? `gap-${i}`)}
      <li>
        {#if p === null}
          <span class="at-pagination__gap" aria-hidden="true">…</span>
        {:else}
          {#snippet num()}{p}{/snippet}
          {@render item(p, num, { current: p === page })}
        {/if}
      </li>
    {/each}
    <li>
      {#if page < pages}
        {@render item(page + 1, right, { label: t('ui.nextPage') })}
      {:else}
        {@render none(right, t('ui.nextPage'))}
      {/if}
    </li>
  </ul>
</nav>
