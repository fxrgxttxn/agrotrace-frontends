<script lang="ts">
  import { page } from '$app/state';
  import BatchView from '$lib/public/BatchView.svelte';
</script>

<BatchView code={page.params.code ?? ''} />
