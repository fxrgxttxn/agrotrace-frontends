<script lang="ts">
  import { page } from '$app/state';
  import PublicPage from '$lib/public/PublicPage.svelte';
</script>

<PublicPage kind="complaint" code={page.params.code} />
