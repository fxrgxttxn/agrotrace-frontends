<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { deadline } from '../../app/recalls';
  import { at } from './recalls';

  let { task, now }: { task: Schemas['RecallTask']; now: number } = $props();
  const left = $derived(deadline(task, now));
</script>

<span class="at-table__primary"
  ><span>{at(task.dueAt)}</span>{#if left}<span class={left.overdue ? 'at-table__sub at-field__warning' : 'at-table__sub'}
      >{left.text}</span
    >{/if}</span
>
