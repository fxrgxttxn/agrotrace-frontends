<script lang="ts">
  import type { Snippet } from 'svelte';
  import { provideField } from './field';

  /** `at-field` without a visible label (README «Поле в ячейке»): a cell input (a waybill's declared mass, a
   * processing input's used mass) named by the control's own `aria-label`; the error element is still
   * `${id}-error`. A direct child of `td` (card mode gives it the column's label above, full width). */
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
