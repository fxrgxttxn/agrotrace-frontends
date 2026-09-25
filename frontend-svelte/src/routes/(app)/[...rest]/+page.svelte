<script lang="ts">
  import { page } from '$app/state';
  import { t } from '$lib/app/i18n';
  import ErrorScreen from '$lib/pages/ErrorScreen.svelte';

  // `*`: no such route. In the development build only, `/_ds` is the component showcase (spec §10.7): `import.meta.env.DEV`
  // is a build-time constant, so the showcase and its chunk are not in the production build.
  const showcase = import.meta.env.DEV && page.url.pathname === '/_ds' ? import('$lib/dev/Showcase.svelte') : null;
</script>

{#if showcase}
  {#await showcase then mod}<mod.default />{/await}
{:else}
  <ErrorScreen title={t('page.notFound')} art="not-found" text={t('empty.notFound')} />
{/if}
