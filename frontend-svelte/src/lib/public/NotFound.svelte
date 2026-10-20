<script lang="ts">
  import { ART } from './art';
  import Art from './Art.svelte';
  import { t } from './i18n';
</script>

<article class="at-card" data-furrow="">
  <div class="at-empty">
    <Art art={ART.emptySearch} />
    <p class="at-empty__text">{t('public.notFound')}</p>
  </div>
</article>
