<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { arrive } from '../app/routeFocus';

  /** `at-page` with its header (README «Страница»): the title is a noun, no subtitle, `tabindex="-1"` — the focus target
   * after a route change (README «Фокус при смене маршрута», `arrive`). Sets the document title. `main` — the page is
   * the document's main landmark itself (screens outside the shell). */
  let {
    title,
    actions,
    main = false,
    style,
    children,
  }: { title: string; actions?: Snippet; main?: boolean; style?: string; children?: Snippet } = $props();

  let h1: HTMLHeadingElement | null = $state(null);

  onMount(() => arrive(page.url.pathname, h1));
  afterNavigate(({ to }) => {
    if (to) arrive(to.url.pathname, h1);
  });

  $effect(() => {
    document.title = `${title} — AgroTrace`;
  });
</script>

{#snippet content()}
  <div class="at-page__header">
    <h1 bind:this={h1} class="at-page__title" tabindex="-1">{title}</h1>
    {#if actions}<div class="at-page__actions">{@render actions()}</div>{/if}
  </div>
  {@render children?.()}
{/snippet}

{#if main}
  <main class="at-page" id="main" tabindex="-1" {style}>{@render content()}</main>
{:else}
  <div class="at-page" {style}>{@render content()}</div>
{/if}
