<script lang="ts">
  import type { Snippet } from 'svelte';
  import { provideField } from './field';

  let { id, error = null, children }: { id: string; error?: string | null; children: Snippet } = $props();

  const errorId = $derived(error ? `${id}-error` : undefined);
  provideField({
    get id() {
      return id;
    },
    get errorId() {
      return errorId;
    },
    get invalid() {
      return Boolean(error);
    },
  });
</script>

<div class="at-field" data-invalid={error ? '' : undefined}>
  {@render children()}
  {#if error}
    <p class="at-field__error" id={errorId} role="alert">{error}</p>
  {/if}
</div>
