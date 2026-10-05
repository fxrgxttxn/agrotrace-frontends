<script lang="ts">
  import { page } from '$app/state';
  import ComplaintView from '$lib/public/ComplaintView.svelte';
</script>

<ComplaintView code={page.params.code ?? ''} />
