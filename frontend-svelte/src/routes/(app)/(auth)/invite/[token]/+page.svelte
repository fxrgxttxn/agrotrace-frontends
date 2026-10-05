<script lang="ts">
  import { page } from '$app/state';
  import InvitePage from '$lib/pages/InvitePage.svelte';
</script>

{#key page.params.token}<InvitePage />{/key}
