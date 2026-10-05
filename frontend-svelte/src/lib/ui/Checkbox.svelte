<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  let {
    checked = $bindable(false),
    indeterminate = false,
    children,
    ...rest
  }: Omit<HTMLInputAttributes, 'type' | 'children'> & { indeterminate?: boolean; children?: Snippet } = $props();

  let input: HTMLInputElement | null = $state(null);
  $effect(() => {
    if (input) input.indeterminate = indeterminate;
  });
</script>

<label class="at-check"><input bind:this={input} type="checkbox" {...rest} bind:checked />{#if children}<span
      >{@render children()}</span
    >{/if}</label>
