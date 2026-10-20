<script lang="ts">
  import type { Snippet } from 'svelte';

  /** `at-switch`: the text is the accessible name; Enter/Space toggle (native button). */
  let {
    checked,
    onchange,
    disabled = false,
    children,
  }: { checked: boolean; onchange: (next: boolean) => void; disabled?: boolean; children: Snippet } = $props();
</script>

<button
  class="at-switch"
  type="button"
  role="switch"
  aria-checked={checked ? 'true' : 'false'}
  {disabled}
  onclick={() => onchange(!checked)}>{@render children()}</button
>
