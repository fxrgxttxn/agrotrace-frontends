<script lang="ts">
  import { page } from '$app/state';
  import PasswordResetPage from '$lib/pages/PasswordResetPage.svelte';
</script>

<!-- A new token is a new link: the screen starts over. -->
{#key page.params.token}<PasswordResetPage />{/key}
