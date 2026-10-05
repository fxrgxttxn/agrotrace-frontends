<script lang="ts">
  import Page from '../ui/Page.svelte';

  let { title }: { title: string } = $props();
</script>

<Page {title} />
