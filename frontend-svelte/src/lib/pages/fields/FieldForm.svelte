<script lang="ts">
  import { dictionary } from '../../app/dictionaries';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import FieldFormReady from './FieldFormReady.svelte';
  import type { FieldT } from './fields';

  let { id, submitLabel, onsaved }: { id: string; submitLabel: string; onsaved: (f: FieldT) => void } = $props();

  const regions = dictionary('regions');
</script>

{#if regions.data}
  <FieldFormReady {id} {submitLabel} {onsaved} regions={regions.data} />
{:else if regions.failed}
  <AreaFailed text={t('fields.failed')} busy={regions.fetching} onretry={() => void userAction(regions.refetch)} />
{:else}
  <AreaLoading blocks={1} />
{/if}
