<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import { fieldControl } from './field';

  /** `at-textarea`. */
  let {
    value = $bindable(),
    id,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedby,
    ...rest
  }: HTMLTextareaAttributes = $props();

  const control = fieldControl(() => ({ id, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedby }));
</script>

<textarea class="at-textarea" {...control()} {...rest} bind:value></textarea>
