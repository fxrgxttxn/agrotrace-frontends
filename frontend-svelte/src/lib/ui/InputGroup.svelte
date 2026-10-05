<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Input from './Input.svelte';

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
