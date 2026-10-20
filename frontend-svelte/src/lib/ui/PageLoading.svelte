<script lang="ts">
  import { t } from '../app/i18n';
</script>

<!-- Loading placeholder of a page area (`aria-busy`). -->
<div class="at-page" aria-busy="true">
  <span class="at-visually-hidden">{t('shell.loading')}</span>
  <div class="at-page__header">
    <span class="at-skeleton" data-shape="text" style="width: 12rem"></span>
  </div>
  <span class="at-skeleton" data-shape="block"></span>
</div>
