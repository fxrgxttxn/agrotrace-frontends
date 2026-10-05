<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import { fieldControl } from './field';

  let {
    value = $bindable(),
    element = $bindable(null),
    id,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedby,
    ...rest
  }: HTMLTextareaAttributes & { element?: HTMLTextAreaElement | null } = $props();

  const control = fieldControl(() => ({ id, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedby }));
</script>

<textarea bind:this={element} class="at-textarea" {...control()} {...rest} bind:value></textarea>
