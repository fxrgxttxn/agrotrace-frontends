<script lang="ts">
  import { page } from '$app/state';
  import { t } from '$lib/app/i18n';
  import ErrorScreen from '$lib/pages/ErrorScreen.svelte';

  const showcase = import.meta.env.DEV && page.url.pathname === '/_ds' ? import('$lib/dev/Showcase.svelte') : null;
</script>

{#if showcase}
  {#await showcase then mod}<mod.default />{/await}
{:else}
  <ErrorScreen title={t('page.notFound')} art="not-found" text={t('empty.notFound')} />
{/if}
