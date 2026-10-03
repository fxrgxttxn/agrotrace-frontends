<script lang="ts">
  import { page } from '$app/state';
  import ComplaintView from '$lib/public/ComplaintView.svelte';
</script>

<!-- One batch per document: another code is another QR page (a full load), never a client-side change. -->
<ComplaintView code={page.params.code ?? ''} />
