<script lang="ts">
  import { page } from '$app/state';
  import ru from '@agrotrace/i18n/public/ru.json';
  import { publicT } from '@agrotrace/i18n/public';
  import { reloadPage, reloadPending } from '$lib/app/chunkFailure';

  const t = publicT(ru, 'ru');
  const reloading = reloadPending(page.error);
</script>

{#if reloading}
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
