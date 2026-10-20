<script lang="ts">
  import type { Snippet } from 'svelte';
  import { provideField } from './field';

  /** `at-field`: label + control + error. Controls inside (Input, Select, Textarea, DateInput, Combobox) take the id,
   * `aria-invalid` and `aria-describedby` from the field. The error element exists only with an error. */
  let {
    id,
    label,
    error = null,
    children,
  }: {
    /** Id of the control; the label points at it, the error element is `${id}-error`. */
    id: string;
    label: string | Snippet;
    /** Error text (already translated). */
    error?: string | null;
    children: Snippet;
  } = $props();

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
  <label class="at-field__label" for={id}>{#if typeof label === 'string'}{label}{:else}{@render label()}{/if}</label>
  {@render children()}
  {#if error}
    <p class="at-field__error" id={errorId} role="alert">{error}</p>
  {/if}
</div>
