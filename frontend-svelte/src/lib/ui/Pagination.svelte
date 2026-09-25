<script lang="ts" module>
  /** Page numbers to show: first, last, current ± 1; `null` is a gap. */
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
  import { t } from '../app/i18n';

  /** `at-pagination` (README «Пагинация»): links keep the rest of the URL state (`hrefFor` builds them). */
  let {
    page,
    size,
    total,
    hrefFor,
  }: {
    /** 1-based, as in the contract. */
    page: number;
    size: number;
    total: number;
    hrefFor: (page: number) => string;
  } = $props();

  const pages = $derived(Math.max(1, Math.ceil(total / size)));
  const from = $derived(total === 0 ? 0 : (page - 1) * size + 1);
  const to = $derived(Math.min(total, page * size));
</script>

{#snippet arrow(dir: 'left' | 'right')}<svg aria-hidden="true"><use href="#i-chevron-{dir}" /></svg>{/snippet}

<nav class="at-pagination" aria-label={t('ui.pages')}>
  <p class="at-pagination__summary">{t('ui.pageSummary', { from, to, total })}</p>
  <ul class="at-pagination__pages">
    <li>
      {#if page > 1}
        <a class="at-pagination__item" href={hrefFor(page - 1)} aria-label={t('ui.prevPage')}>{@render arrow('left')}</a>
      {:else}
        <button class="at-pagination__item" type="button" aria-label={t('ui.prevPage')} disabled
          >{@render arrow('left')}</button
        >
      {/if}
    </li>
    {#each pageWindow(page, pages) as p, i (p ?? `gap-${i}`)}
      <li>
        {#if p === null}
          <span class="at-pagination__gap" aria-hidden="true">…</span>
        {:else}
          <a class="at-pagination__item" href={hrefFor(p)} aria-current={p === page ? 'page' : undefined}>{p}</a>
        {/if}
      </li>
    {/each}
    <li>
      {#if page < pages}
        <a class="at-pagination__item" href={hrefFor(page + 1)} aria-label={t('ui.nextPage')}>{@render arrow('right')}</a>
      {:else}
        <button class="at-pagination__item" type="button" aria-label={t('ui.nextPage')} disabled
          >{@render arrow('right')}</button
        >
      {/if}
    </li>
  </ul>
</nav>
