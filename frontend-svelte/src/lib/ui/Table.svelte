<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { t } from '../app/i18n';
  import Checkbox from './Checkbox.svelte';
  import { ariaSort, formatSort, parseSort, type Column, type SortState, type TableSelection } from './table';

  let {
    columns,
    rows,
    rowKey,
    caption,
    cards = false,
    sort = null,
    onsort,
    sortOptions,
    selection,
    actions,
    cell,
  }: {
    columns: Column<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    caption?: string;
    cards?: boolean;
    sort?: SortState | null;
    onsort?: (next: SortState) => void;
    sortOptions?: { value: string; label: string }[];
    selection?: TableSelection<T>;
    actions?: Snippet<[T]>;
    cell?: Snippet<[T, Column<T>]>;
  } = $props();

  const keys = $derived(rows.map(rowKey));
  const selectedCount = $derived(selection ? keys.filter((k) => selection.selected.has(k)).length : 0);
  const all = $derived(rows.length > 0 && selectedCount === rows.length);
  const some = $derived(selectedCount > 0 && !all);

  function toggleAll() {
    selection?.onchange(all ? new Set() : new Set(keys));
  }
  function toggle(k: string) {
    if (!selection) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const next = new Set(selection.selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    selection.onchange(next);
  }
  function sortBy(field: string) {
    onsort?.({ field, dir: sort?.field === field && sort.dir === 'asc' ? 'desc' : 'asc' });
  }
</script>

{#if cards && (selection || sortOptions)}
  <div class="at-table-mobilebar">
    {#if selection}
      <Checkbox checked={all} indeterminate={some} onchange={toggleAll}>{t('ui.selectAll')}</Checkbox>
    {/if}
    {#if sortOptions}
      <label class="at-table-mobilebar__sort">
        <span class="at-visually-hidden">{t('ui.sort')}</span>
        <select
          class="at-select"
          value={sort ? formatSort(sort) : ''}
          onchange={(e) => {
            const s = parseSort(e.currentTarget.value);
            if (s) onsort?.(s);
          }}
        >
          {#if !sort}
            <option value="" disabled>{t('ui.sortDefault')}</option>
          {/if}
          {#each sortOptions as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
{/if}
<div class="at-table-wrap">
  <table class="at-table" data-cards={cards ? '' : undefined}>
    {#if caption}<caption class="at-visually-hidden">{caption}</caption>{/if}
    <thead>
      <tr>
        {#if selection}
          <th class="at-table__select" scope="col">
            <Checkbox checked={all} indeterminate={some} onchange={toggleAll} aria-label={selection.allLabel} />
          </th>
        {/if}
        {#each columns as c (c.key)}
          <th scope="col" data-numeric={c.numeric ? '' : undefined} aria-sort={ariaSort(c, sort)}>
            {#if c.sortField}
              {@const field = c.sortField}
              <button class="at-table__sort" type="button" onclick={() => sortBy(field)}>{c.header}</button>
            {:else}
              {c.header}
            {/if}
          </th>
        {/each}
        {#if actions}
          <th scope="col"><span class="at-visually-hidden">{t('ui.actions')}</span></th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (rowKey(row))}
        {@const k = rowKey(row)}
        {@const on = selection?.selected.has(k) ?? false}
        <tr data-selected={on ? '' : undefined}>
          {#if selection}
            <td class="at-table__select">
              <Checkbox
                checked={on}
                onchange={() => toggle(k)}
                aria-label={selection.rowLabel(row)}
                aria-invalid={selection.errorId ? 'true' : undefined}
                aria-describedby={selection.errorId ?? undefined}
              />
            </td>
          {/if}
          {#each columns as c (c.key)}
            <td
              data-label={c.header}
              data-primary={c.primary ? '' : undefined}
              data-status-cell={c.status ? '' : undefined}
              data-numeric={c.numeric ? '' : undefined}
            >
              {#if cell}{@render cell(row, c)}{:else}{c.text?.(row) ?? ''}{/if}
            </td>
          {/each}
          {#if actions}
            <td class="at-table__actions">{@render actions(row)}</td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
