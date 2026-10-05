<script lang="ts">
  import { t } from './i18n';
</script>

<div class="at-card" data-furrow="" aria-busy="true">
  <div class="at-card__body at-public__loading">
    <span class="at-visually-hidden">{t('shell.loading')}</span>
    <span class="at-skeleton" data-shape="block"></span>
    <span class="at-skeleton" data-shape="text" style="width: 60%"></span>
    <span class="at-skeleton" data-shape="text" style="width: 40%"></span>
  </div>
</div>
