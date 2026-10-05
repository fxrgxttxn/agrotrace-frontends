<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  let { children, ...rest }: Omit<HTMLInputAttributes, 'type' | 'children'> & { children: Snippet } = $props();
</script>

<label class="at-radio"><input type="radio" {...rest} /><span>{@render children()}</span></label>
