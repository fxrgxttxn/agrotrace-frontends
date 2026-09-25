<script lang="ts">
  import Page from '../ui/Page.svelte';

  // Placeholder of a screen: the task that owns it (S2–S8, like React's Tasks 2–8) replaces it.
  let { title }: { title: string } = $props();
</script>

<Page {title} />
