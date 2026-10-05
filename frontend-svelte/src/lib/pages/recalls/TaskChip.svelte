<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { t } from '../../app/i18n';
  import { deadline, TASK_TONE } from '../../app/recalls';
  import Chip from '../../ui/Chip.svelte';

  let { task, now }: { task: Pick<Schemas['RecallTask'], 'status' | 'dueAt'>; now: number } = $props();
  const status = $derived(deadline(task, now)?.overdue ? 'OVERDUE' : task.status);
</script>

<Chip tone={TASK_TONE[status]}>{enumLabel(t, 'RecallTaskStatus', status)}</Chip>
