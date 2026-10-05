<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { at } from './recalls';

  let { task }: { task: Schemas['RecallTask'] } = $props();
</script>

{#if task.confirmedAt}<span class="at-table__primary"
    ><span>{at(task.confirmedAt)}</span>{#if task.confirmedBy}<span class="at-table__sub">{task.confirmedBy.fullName}</span
      >{/if}</span
  >{:else}—{/if}
