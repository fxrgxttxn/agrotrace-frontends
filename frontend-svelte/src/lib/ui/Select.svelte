<script lang="ts">
  import type { HTMLSelectAttributes } from 'svelte/elements';
  import { fieldControl } from './field';

  let {
    value = $bindable(),
    id,
    children,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedby,
    ...rest
  }: HTMLSelectAttributes = $props();

  const control = fieldControl(() => ({ id, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedby }));
</script>

<select class="at-select" {...control()} {...rest} bind:value>
  {@render children?.()}
</select>
