<script lang="ts">
  import { page } from '$app/state';
  import { createT } from '@agrotrace/i18n';
  import { reloadPage, reloadPending } from '$lib/app/chunkFailure';

  // Last-resort error page (the public QR pages, or a root failure): never SvelteKit's raw error. Light on purpose —
  // no cabinet module (the public group shares it). FM11/FM15: while the one automatic reload starts — a busy page;
  // then one line and «Повторить» (a reload).
  const t = createT('ru');
</script>

{#if reloadPending(page.error)}
  <main class="at-page" id="main" tabindex="-1" aria-busy="true"></main>
{:else}
  <main class="at-page" id="main" tabindex="-1">
    <div class="at-page__header">
      <h1 class="at-page__title" tabindex="-1">AgroTrace</h1>
    </div>
    <div class="at-empty">
      <p class="at-empty__text">{t('empty.pageLoadFailed')}</p>
      <button class="at-button" type="button" data-variant="primary" onclick={reloadPage}>{t('action.retry')}</button>
    </div>
  </main>
{/if}
