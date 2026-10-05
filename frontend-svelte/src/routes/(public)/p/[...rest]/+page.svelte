<script lang="ts">
  import { publicFrame } from '$lib/public/frame.svelte';
  import { t } from '$lib/public/i18n';
  import NotFound from '$lib/public/NotFound.svelte';

  publicFrame(() => t('page.publicBatch'));
</script>

<main class="at-page at-public" id="main" tabindex="-1">
  <div class="at-page__header"><h1 class="at-page__title" tabindex="-1">{t('page.publicBatch')}</h1></div>
  <div class="at-public__stack"><NotFound /></div>
</main>
