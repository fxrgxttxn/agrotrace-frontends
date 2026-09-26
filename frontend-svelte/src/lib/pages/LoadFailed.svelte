<script lang="ts">
  import { page } from '$app/state';
  import { reloadPage, reloadPending } from '../app/chunkFailure';
  import { t } from '../app/i18n';
  import { cabinetRoute } from '../app/routes';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Empty from '../ui/Empty.svelte';
  import Page from '../ui/Page.svelte';
  import PageLoading from '../ui/PageLoading.svelte';

  /** FM11: the page could not be loaded (its chunk failed twice): the screen's own title, one line, «Повторить» (a
   * reload). While the one automatic full load is starting — the loading page. `standalone`: outside the shell. */
  let { standalone = false }: { standalone?: boolean } = $props();

  const title = $derived(t(cabinetRoute(page.url.pathname)?.title ?? 'page.notFound'));
  // Decided once, when this failure page is created: the automatic reload marks the page right after, and the
  // failure text must not flash in the document that is about to be replaced.
  const reloading = reloadPending(page.error);
</script>

{#if reloading}
  <PageLoading />
{:else}
  <Page {title} main={standalone} style={standalone ? 'max-width: 30rem' : undefined}>
    <Card>
      <Empty art="empty-search" text={t('empty.pageLoadFailed')}>
        {#snippet action()}
          <Button variant="primary" onclick={reloadPage}>{t('action.retry')}</Button>
        {/snippet}
      </Empty>
    </Card>
  </Page>
{/if}
