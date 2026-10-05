<script lang="ts">
  import { t } from '../app/i18n';

  let { blocks = 2 }: { blocks?: number } = $props();
</script>

<div aria-busy="true" style="display: grid; gap: var(--sp-3)">
  <span class="at-visually-hidden">{t('shell.loading')}</span>
  {#each { length: blocks }, i (i)}<span class="at-skeleton" data-shape="block"></span>{/each}
</div>
