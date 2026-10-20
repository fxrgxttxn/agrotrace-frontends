<script lang="ts" module>
  export interface TabDef {
    id: string;
    label: string;
    count?: number;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  /** `at-tabs` (README «Вкладки»): roving tabindex, ←/→ (wrapping), Home/End, selection follows focus. Every panel is
   * rendered; only the selected one has content, the others are empty and `hidden`. The caller mirrors the selection
   * in `?tab=`. */
  let {
    label,
    tabs,
    selected,
    onselect,
    panel,
  }: {
    label: string;
    tabs: TabDef[];
    selected: string;
    onselect: (id: string) => void;
    /** Content of a panel; rendered for the selected tab only. */
    panel: Snippet<[string]>;
  } = $props();

  // Element registry for focus moves, not rendered state.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const refs = new Map<string, HTMLButtonElement>();

  function register(el: HTMLButtonElement, id: string) {
    refs.set(id, el);
    return {
      destroy() {
        if (refs.get(id) === el) refs.delete(id);
      },
    };
  }

  // A narrow tab row scrolls sideways: the selected tab (e.g. `?tab=docs` at 360 px) is scrolled into the row's view,
  // horizontally only (the page itself does not jump).
  $effect(() => {
    const tab = refs.get(selected);
    const row = tab?.parentElement;
    if (!tab || !row) return;
    const t0 = tab.getBoundingClientRect();
    const r0 = row.getBoundingClientRect();
    if (t0.left < r0.left) row.scrollLeft -= r0.left - t0.left;
    else if (t0.right > r0.right) row.scrollLeft += t0.right - r0.right;
  });

  function keydown(e: KeyboardEvent) {
    const i = tabs.findIndex((tab) => tab.id === selected);
    const next = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 } as Record<string, number>)[
      e.key
    ];
    if (next === undefined) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length]!;
    onselect(target.id);
    refs.get(target.id)?.focus();
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="at-tabs" role="tablist" aria-label={label} onkeydown={keydown}>
  {#each tabs as tab (tab.id)}
    {@const on = tab.id === selected}
    <button
      use:register={tab.id}
      class="at-tabs__tab"
      role="tab"
      id="tab-{tab.id}"
      aria-selected={on ? 'true' : 'false'}
      aria-controls="panel-{tab.id}"
      tabindex={on ? 0 : -1}
      type="button"
      onclick={() => onselect(tab.id)}
      >{tab.count === undefined ? tab.label : `${tab.label} `}{#if tab.count !== undefined}<span class="at-tabs__count">{tab.count}</span>{/if}</button
    >
  {/each}
</div>
{#each tabs as tab (tab.id)}
  <div
    class="at-tabs__panel"
    role="tabpanel"
    id="panel-{tab.id}"
    aria-labelledby="tab-{tab.id}"
    tabindex="0"
    hidden={tab.id !== selected}
  >
    {#if tab.id === selected}{@render panel(tab.id)}{/if}
  </div>
{/each}
