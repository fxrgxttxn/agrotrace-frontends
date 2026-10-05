<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    legend,
    error = null,
    errorId,
    direction = 'column',
    children,
  }: {
    legend: string;
    error?: string | null;
    errorId?: string;
    direction?: 'column' | 'row';
    children: Snippet;
  } = $props();
</script>

<fieldset class="at-field" data-invalid={error ? '' : undefined}>
  <legend class="at-field__label">{legend}</legend>
  <div class="at-field__options" data-direction={direction}>
    {@render children()}
  </div>
  {#if error}
    <p class="at-field__error" id={errorId} role="alert">{error}</p>
  {/if}
</fieldset>
