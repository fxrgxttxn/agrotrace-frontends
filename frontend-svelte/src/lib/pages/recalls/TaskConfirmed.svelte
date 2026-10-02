<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { at } from './recalls';

  /** When and by whom the withdrawal was confirmed; «—» before that. */
  let { task }: { task: Schemas['RecallTask'] } = $props();
</script>

{#if task.confirmedAt}<span class="at-table__primary"
    ><span>{at(task.confirmedAt)}</span>{#if task.confirmedBy}<span class="at-table__sub">{task.confirmedBy.fullName}</span
      >{/if}</span
  >{:else}—{/if}
