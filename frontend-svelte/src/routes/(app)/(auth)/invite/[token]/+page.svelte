<script lang="ts">
  import { page } from '$app/state';
  import InvitePage from '$lib/pages/InvitePage.svelte';
</script>

<!-- A new token is a new link: the screen starts over. -->
{#key page.params.token}<InvitePage />{/key}
