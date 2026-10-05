<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { fieldControl } from './field';

  let {
    mono = false,
    value = $bindable(),
    element = $bindable(null),
    id,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedby,
    ...rest
  }: HTMLInputAttributes & { mono?: boolean; element?: HTMLInputElement | null } = $props();

  const control = fieldControl(() => ({ id, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedby }));
</script>

<input bind:this={element} class={mono ? 'at-input at-mono' : 'at-input'} {...control()} {...rest} bind:value />
