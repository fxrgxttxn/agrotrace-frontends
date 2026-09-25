<script lang="ts">
  import '@agrotrace/design-system/index.css';
  import type { Snippet } from 'svelte';

  // Root of both route groups: `(app)` — the cabinet and auth screens (session, shell), `(public)` — the QR pages
  // (spec §9.6: no cabinet code). Nothing else lives here, so the public chunks stay light.
  let { children }: { children: Snippet } = $props();
</script>

{@render children()}
