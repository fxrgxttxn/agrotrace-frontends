<script lang="ts">
  import { page } from '$app/state';
  import BatchView from '$lib/public/BatchView.svelte';
</script>

<!-- One batch per document: another code is another QR page (a full load), never a client-side change. -->
<BatchView code={page.params.code ?? ''} />
