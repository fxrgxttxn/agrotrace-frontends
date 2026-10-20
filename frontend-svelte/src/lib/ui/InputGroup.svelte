<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Input from './Input.svelte';

  /** `at-input-group`: a number aligned right against its unit (`кг`, `га`, `мг/кг`). */
  let {
    suffix,
    value = $bindable(),
    ...rest
  }: HTMLInputAttributes & { suffix: string; mono?: boolean } = $props();
</script>

<div class="at-input-group">
  <Input {...rest} bind:value />
  <span class="at-input-group__suffix">{suffix}</span>
</div>
