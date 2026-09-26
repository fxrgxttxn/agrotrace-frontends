<script lang="ts">
  import { createT } from '@agrotrace/i18n';

  // Last-resort error page (the public QR pages, or a root failure): never SvelteKit's raw error. Light on purpose —
  // no cabinet module (the public group shares it). FM11: one line and «Повторить» (a reload).
  const t = createT('ru');
</script>

<main class="at-page" id="main" tabindex="-1">
  <div class="at-page__header">
    <h1 class="at-page__title" tabindex="-1">AgroTrace</h1>
  </div>
  <div class="at-empty">
    <p class="at-empty__text">{t('empty.pageLoad')}</p>
    <button class="at-button" type="button" data-variant="primary" onclick={() => location.reload()}
      >{t('action.retry')}</button
    >
  </div>
</main>
