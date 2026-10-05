<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { arrive } from '../app/routeFocus';

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
