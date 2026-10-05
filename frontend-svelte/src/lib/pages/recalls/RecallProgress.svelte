<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { t } from '../../app/i18n';
  import Progress from '../../ui/Progress.svelte';

  let {
    id,
    progress,
    inTable = false,
  }: { id: string; progress: Schemas['RecallProgress']; inTable?: boolean } = $props();
</script>

<div style="display: grid; gap: var(--sp-1)">
  <Progress
    {id}
    label={t('recalls.progress')}
    value={progress.confirmed}
    max={progress.total}
    tone={progress.overdue > 0 ? 'danger' : undefined}
    labelHidden={inTable}
  />
  {#if progress.overdue > 0}
    <span class="at-table__sub at-field__warning">{t('recalls.overdueCount', { count: progress.overdue })}</span>
  {/if}
</div>
