<script lang="ts">
  import { page } from '$app/state';
  import PasswordResetPage from '$lib/pages/PasswordResetPage.svelte';
</script>

{#key page.params.token}<PasswordResetPage />{/key}
