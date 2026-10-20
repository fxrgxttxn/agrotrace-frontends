<script lang="ts">
  import type { Snippet } from 'svelte';
  import { FORM_GRID } from './layout';

  /** Text + one action instead of a form (link sent, dead link, application sent). */
  let { text, action }: { text: string; action: Snippet } = $props();
</script>

<div style={FORM_GRID}>
  <p>{text}</p>
  <div>{@render action()}</div>
</div>
