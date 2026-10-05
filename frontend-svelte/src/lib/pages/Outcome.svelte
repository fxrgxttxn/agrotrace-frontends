<script lang="ts">
  import type { Snippet } from 'svelte';
  import { FORM_GRID } from './layout';

  let { text, action }: { text: string; action: Snippet } = $props();
</script>

<div style={FORM_GRID}>
  <p>{text}</p>
  <div>{@render action()}</div>
</div>
